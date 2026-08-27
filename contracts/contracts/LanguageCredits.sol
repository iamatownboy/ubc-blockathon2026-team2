// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// @title LanguageCredits
/// @notice A dedicated, non-transferable credit ledger for LanguageToken.
///
///         This is intentionally NOT an ERC-20 with transfers switched off:
///         there is no `transfer`, `approve` or `permit` at all, and the test
///         suite asserts the ABI stays that way.
///
///         Every event field is bytes32 or a number. Nothing on chain can
///         carry a name, an e-mail address or a card number.
///
///         Authority is split on purpose:
///           ADMIN_ROLE     configures missions and the catalog, pauses,
///                          grants roles, and may cancel a swap
///           VERIFIER_ROLE  awards the *configured* amount for a passed
///                          mission — and nothing else (no amount parameter)
///           REDEEMER_ROLE  burns credits and opens a swap
///           FULFILLER_ROLE settles a swap once the provider confirms, or
///                          cancels and refunds
contract LanguageCredits is AccessControl, Pausable {
    // ---------------------------------------------------------------- roles

    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant VERIFIER_ROLE = keccak256("VERIFIER_ROLE");
    bytes32 public constant REDEEMER_ROLE = keccak256("REDEEMER_ROLE");
    bytes32 public constant FULFILLER_ROLE = keccak256("FULFILLER_ROLE");

    // ------------------------------------------------- limits the admin cannot raise

    /// @dev What one bad award can cost (2,000 credits = CAD 100).
    uint128 public constant MAX_MISSION_REWARD = 2000;
    /// @dev What a farmed handle can ever extract (15,000 credits = CAD 750).
    uint128 public constant LIFETIME_CAP = 15000;
    /// @dev Credits expire this long after the learner's most recent award.
    uint64 public constant CREDIT_TTL = 365 days;
    /// @dev An expired account still gets a usable window for an exact refund.
    uint64 public constant REFUND_GRACE_PERIOD = 30 days;

    // ---------------------------------------------------------------- types

    struct Mission {
        uint128 reward;
        uint32 version;
        bool active;
        bool exists;
    }

    struct CatalogItem {
        bytes32 productCode; // the provider's own identifier, e.g. TIMHORTONS-CA-0500
        uint128 cost;
        uint64 inventory; // stock a sponsor has already funded
        bool active;
        bool exists;
    }

    struct Account {
        uint128 balance;
        uint128 lifetimeAwarded;
        uint64 expiresAt;
    }

    enum SwapStatus {
        None,
        Requested,
        Settled,
        Cancelled
    }

    struct Swap {
        bytes32 learnerHash;
        bytes32 itemId;
        bytes32 requestHash;
        bytes32 voucherCommitment;
        uint128 cost; // recorded at request time so a refund is exact
        SwapStatus status;
    }

    // ---------------------------------------------------------------- state

    mapping(bytes32 => Mission) private _missions;
    mapping(bytes32 => CatalogItem) private _items;
    mapping(bytes32 => Account) private _accounts;
    /// @dev learnerHash => missionId => version => completed
    mapping(bytes32 => mapping(bytes32 => mapping(uint32 => bool))) private _completed;
    Swap[] private _swaps;

    /// @dev Conservation: awarded == outstanding + inSwap + swapped + expired.
    uint256 public totalAwarded;
    uint256 public totalOutstanding;
    uint256 public totalInSwap;
    uint256 public totalSwapped;
    uint256 public totalExpired;

    // ---------------------------------------------------------------- events
    // every field is bytes32 or uint — nothing can carry a name

    event MissionConfigured(bytes32 indexed missionId, uint128 reward, uint32 version, bool active);
    event CatalogItemConfigured(
        bytes32 indexed itemId,
        bytes32 indexed productCode,
        uint128 cost,
        uint64 inventory,
        bool active
    );
    event CreditsAwarded(
        bytes32 indexed learnerHash,
        bytes32 indexed missionId,
        uint32 version,
        uint128 amount,
        bytes32 proofHash,
        uint64 expiresAt
    );
    event CreditsExpired(bytes32 indexed learnerHash, uint128 amount);
    event SwapRequested(
        uint256 indexed swapId,
        bytes32 indexed learnerHash,
        bytes32 indexed itemId,
        uint128 cost,
        bytes32 requestHash
    );
    event SwapSettled(uint256 indexed swapId, bytes32 voucherCommitment);
    event SwapCancelled(uint256 indexed swapId, bytes32 reason);

    // ---------------------------------------------------------------- errors

    error RewardTooLarge(uint128 reward, uint128 max);
    error InvalidAmount();
    error MissionNotActive(bytes32 missionId);
    error MissionAlreadyCompleted(bytes32 learnerHash, bytes32 missionId, uint32 version);
    error LifetimeCapExceeded(bytes32 learnerHash, uint128 lifetimeAwarded, uint128 reward);
    error ItemNotAvailable(bytes32 itemId);
    error OutOfStock(bytes32 itemId);
    error InsufficientCredits(bytes32 learnerHash, uint128 balance, uint128 cost);
    error InvalidSwap(uint256 swapId);
    error NothingToSweep(bytes32 learnerHash);

    // ---------------------------------------------------------------- setup

    constructor(address admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ADMIN_ROLE, admin);
        _setRoleAdmin(ADMIN_ROLE, DEFAULT_ADMIN_ROLE);
        _setRoleAdmin(VERIFIER_ROLE, ADMIN_ROLE);
        _setRoleAdmin(REDEEMER_ROLE, ADMIN_ROLE);
        _setRoleAdmin(FULFILLER_ROLE, ADMIN_ROLE);
    }

    // ---------------------------------------------------------------- admin

    /// @notice Create or update a mission. The reward is bounded by a
    ///         constant the admin cannot raise. Bumping the version lets a
    ///         learner complete the revised mission again.
    function configureMission(
        bytes32 missionId,
        uint128 reward,
        uint32 version,
        bool active
    ) external onlyRole(ADMIN_ROLE) {
        if (reward == 0) revert InvalidAmount();
        if (reward > MAX_MISSION_REWARD) revert RewardTooLarge(reward, MAX_MISSION_REWARD);
        _missions[missionId] = Mission({reward: reward, version: version, active: active, exists: true});
        emit MissionConfigured(missionId, reward, version, active);
    }

    /// @notice Create or update a catalog item. Inventory is stock a sponsor
    ///         has already funded — nothing is listed beyond it.
    function configureCatalogItem(
        bytes32 itemId,
        bytes32 productCode,
        uint128 cost,
        uint64 inventory,
        bool active
    ) external onlyRole(ADMIN_ROLE) {
        if (cost == 0) revert InvalidAmount();
        _items[itemId] = CatalogItem({
            productCode: productCode,
            cost: cost,
            inventory: inventory,
            active: active,
            exists: true
        });
        emit CatalogItemConfigured(itemId, productCode, cost, inventory, active);
    }

    function pause() external onlyRole(ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(ADMIN_ROLE) {
        _unpause();
    }

    // ---------------------------------------------------------------- award

    /// @notice Award the mission's configured reward. There is no amount
    ///         parameter: a stolen verifier key can pick a mission, not a
    ///         number. Once per learner per mission version, under a
    ///         lifetime cap.
    function awardCredits(
        bytes32 learnerHash,
        bytes32 missionId,
        bytes32 proofHash
    ) external onlyRole(VERIFIER_ROLE) whenNotPaused {
        Mission storage mission = _missions[missionId];
        if (!mission.exists || !mission.active) revert MissionNotActive(missionId);
        if (_completed[learnerHash][missionId][mission.version]) {
            revert MissionAlreadyCompleted(learnerHash, missionId, mission.version);
        }

        _sweepIfExpired(learnerHash);

        Account storage account = _accounts[learnerHash];
        uint128 reward = mission.reward;
        if (account.lifetimeAwarded + reward > LIFETIME_CAP) {
            revert LifetimeCapExceeded(learnerHash, account.lifetimeAwarded, reward);
        }

        _completed[learnerHash][missionId][mission.version] = true;
        account.balance += reward;
        account.lifetimeAwarded += reward;
        account.expiresAt = uint64(block.timestamp) + CREDIT_TTL;
        totalAwarded += reward;
        totalOutstanding += reward;

        emit CreditsAwarded(learnerHash, missionId, mission.version, reward, proofHash, account.expiresAt);
    }

    // ---------------------------------------------------------------- expiry

    /// @notice Permissionless: anyone can run the sweeper, nobody can choose
    ///         the outcome.
    function sweepExpired(bytes32 learnerHash) external {
        Account storage account = _accounts[learnerHash];
        if (account.balance == 0 || !_isExpired(account)) revert NothingToSweep(learnerHash);
        _expire(learnerHash, account);
    }

    // ---------------------------------------------------------------- swap

    /// @notice Burn first. Credits leave the balance and one unit of stock is
    ///         taken before the provider is ever called; the swap stays
    ///         Requested until a card is in hand.
    function requestSwap(
        bytes32 learnerHash,
        bytes32 itemId,
        bytes32 requestHash
    ) external onlyRole(REDEEMER_ROLE) whenNotPaused returns (uint256 swapId) {
        CatalogItem storage item = _items[itemId];
        if (!item.exists || !item.active) revert ItemNotAvailable(itemId);
        if (item.inventory == 0) revert OutOfStock(itemId);

        _sweepIfExpired(learnerHash);

        Account storage account = _accounts[learnerHash];
        uint128 cost = item.cost;
        if (account.balance < cost) revert InsufficientCredits(learnerHash, account.balance, cost);

        account.balance -= cost;
        item.inventory -= 1;
        totalOutstanding -= cost;
        totalInSwap += cost;

        swapId = _swaps.length;
        _swaps.push(
            Swap({
                learnerHash: learnerHash,
                itemId: itemId,
                requestHash: requestHash,
                voucherCommitment: bytes32(0),
                cost: cost,
                status: SwapStatus.Requested
            })
        );
        emit SwapRequested(swapId, learnerHash, itemId, cost, requestHash);
    }

    /// @notice Settle once the provider has confirmed a card. Only a
    ///         commitment goes on chain — never the card.
    function settleSwap(uint256 swapId, bytes32 voucherCommitment)
        external
        onlyRole(FULFILLER_ROLE)
        whenNotPaused
    {
        Swap storage swap = _swap(swapId);
        if (swap.status != SwapStatus.Requested) revert InvalidSwap(swapId);
        swap.status = SwapStatus.Settled;
        swap.voucherCommitment = voucherCommitment;
        totalInSwap -= swap.cost;
        totalSwapped += swap.cost;
        emit SwapSettled(swapId, voucherCommitment);
    }

    /// @notice Refund: credits and stock are restored exactly. Deliberately
    ///         NOT blocked by pause — refunding learners must never require
    ///         un-pausing first.
    function cancelSwap(uint256 swapId, bytes32 reason) external {
        if (!hasRole(FULFILLER_ROLE, msg.sender) && !hasRole(ADMIN_ROLE, msg.sender)) {
            revert AccessControlUnauthorizedAccount(msg.sender, FULFILLER_ROLE);
        }
        Swap storage swap = _swap(swapId);
        if (swap.status != SwapStatus.Requested) revert InvalidSwap(swapId);
        swap.status = SwapStatus.Cancelled;
        Account storage account = _accounts[swap.learnerHash];
        if (_isExpired(account)) {
            // First account for any other expired balance, then make the
            // exact refund usable for a short and explicit grace period.
            if (account.balance != 0) _expire(swap.learnerHash, account);
            account.expiresAt = uint64(block.timestamp) + REFUND_GRACE_PERIOD;
        }
        account.balance += swap.cost;
        _items[swap.itemId].inventory += 1;
        totalInSwap -= swap.cost;
        totalOutstanding += swap.cost;
        emit SwapCancelled(swapId, reason);
    }

    // ---------------------------------------------------------------- views

    function balanceOf(bytes32 learnerHash) external view returns (uint128) {
        Account storage account = _accounts[learnerHash];
        if (_isExpired(account)) return 0;
        return account.balance;
    }

    function accountOf(bytes32 learnerHash) external view returns (Account memory) {
        return _accounts[learnerHash];
    }

    function missionCompleted(bytes32 learnerHash, bytes32 missionId) external view returns (bool) {
        Mission storage mission = _missions[missionId];
        return _completed[learnerHash][missionId][mission.version];
    }

    function missionOf(bytes32 missionId) external view returns (Mission memory) {
        return _missions[missionId];
    }

    function itemOf(bytes32 itemId) external view returns (CatalogItem memory) {
        return _items[itemId];
    }

    function swapOf(uint256 swapId) external view returns (Swap memory) {
        if (swapId >= _swaps.length) revert InvalidSwap(swapId);
        return _swaps[swapId];
    }

    function swapCount() external view returns (uint256) {
        return _swaps.length;
    }

    // ---------------------------------------------------------------- internal

    function _isExpired(Account storage account) private view returns (bool) {
        return account.expiresAt != 0 && block.timestamp >= account.expiresAt;
    }

    function _sweepIfExpired(bytes32 learnerHash) private {
        Account storage account = _accounts[learnerHash];
        if (account.balance != 0 && _isExpired(account)) _expire(learnerHash, account);
    }

    function _expire(bytes32 learnerHash, Account storage account) private {
        uint128 amount = account.balance;
        account.balance = 0;
        totalOutstanding -= amount;
        totalExpired += amount;
        emit CreditsExpired(learnerHash, amount);
    }

    function _swap(uint256 swapId) private view returns (Swap storage) {
        if (swapId >= _swaps.length) revert InvalidSwap(swapId);
        return _swaps[swapId];
    }
}
