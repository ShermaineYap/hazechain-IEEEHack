// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IEvidenceRegistry {
    function rootOf(uint32 day) external view returns (bytes32);
    function isOracle(address a) external view returns (bool);
}

/// @title FireFreeEscrow
/// @notice Results-based "pay-for-no-fire" escrow for peatland polygons (villages or concessions).
///         A funder locks funds against a polygon for a fire season. After the season the oracle
///         reports the number of attributed ignitions, citing a day of evidence already anchored in
///         EvidenceRegistry. After a dispute window the pledge settles automatically:
///           - no confident ignition  -> funds go to the beneficiary (the reward)
///           - confident ignition(s)  -> funds go to the suppression pool (the slash)
///         The beneficiary can dispute within the window with ground evidence; an arbiter resolves.
///         If the oracle never reports, the funder can reclaim after a grace period.
contract FireFreeEscrow is Ownable, ReentrancyGuard {
    enum Status { None, Active, Reported, Disputed, Paid, Slashed, Refunded }

    struct Pledge {
        address funder;
        address payable beneficiary;
        address payable slashPool;
        uint64 seasonStart;
        uint64 seasonEnd;
        uint64 disputeDeadline;
        uint32 ignitions;          // attributed ignitions in the polygon during the season
        uint16 confidenceBps;      // oracle's attribution confidence, basis points
        uint32 evidenceDay;        // YYYYMMDD of the anchored evidence bundle cited
        Status status;
        uint256 amount;
        string polygonId;          // e.g. "GFW-OP-743" or a village id
        string disputeUri;         // beneficiary's counter-evidence
    }

    IEvidenceRegistry public immutable registry;
    uint64 public immutable disputeWindow;     // seconds (7 days in production; minutes on a demo testnet)
    uint64 public immutable reportGrace;       // seconds after seasonEnd before funder may reclaim
    uint16 public immutable confidenceThresholdBps; // ignitions below this confidence do not slash

    Pledge[] private _pledges;

    event Funded(uint256 indexed id, string polygonId, address indexed funder, address indexed beneficiary, uint256 amount, uint64 seasonStart, uint64 seasonEnd);
    event Reported(uint256 indexed id, uint32 ignitions, uint16 confidenceBps, uint32 evidenceDay, bytes32 evidenceRoot, uint64 disputeDeadline);
    event Disputed(uint256 indexed id, string uri);
    event DisputeResolved(uint256 indexed id, uint32 ignitions, uint16 confidenceBps);
    event Settled(uint256 indexed id, Status outcome, address to, uint256 amount);

    error NotOracle();
    error BadStatus(Status s);
    error SeasonNotOver();
    error WindowOpen();
    error WindowClosed();
    error NotBeneficiary();
    error NotFunder();
    error EvidenceNotAnchored(uint32 day);
    error BadParams();
    error TransferFailed();

    constructor(address registry_, uint64 disputeWindow_, uint64 reportGrace_, uint16 confidenceThresholdBps_) Ownable(msg.sender) {
        if (registry_ == address(0) || confidenceThresholdBps_ > 10_000) revert BadParams();
        registry = IEvidenceRegistry(registry_);
        disputeWindow = disputeWindow_;
        reportGrace = reportGrace_;
        confidenceThresholdBps = confidenceThresholdBps_;
    }

    modifier onlyOracle() {
        if (!registry.isOracle(msg.sender)) revert NotOracle();
        _;
    }

    // ---------------------------------------------------------------- funder

    function fund(
        string calldata polygonId,
        address payable beneficiary,
        address payable slashPool,
        uint64 seasonStart,
        uint64 seasonEnd
    ) external payable returns (uint256 id) {
        if (msg.value == 0 || beneficiary == address(0) || slashPool == address(0) || seasonEnd <= seasonStart || bytes(polygonId).length == 0) revert BadParams();
        id = _pledges.length;
        _pledges.push(Pledge({
            funder: msg.sender,
            beneficiary: beneficiary,
            slashPool: slashPool,
            seasonStart: seasonStart,
            seasonEnd: seasonEnd,
            disputeDeadline: 0,
            ignitions: 0,
            confidenceBps: 0,
            evidenceDay: 0,
            status: Status.Active,
            amount: msg.value,
            polygonId: polygonId,
            disputeUri: ""
        }));
        emit Funded(id, polygonId, msg.sender, beneficiary, msg.value, seasonStart, seasonEnd);
    }

    /// @notice If the oracle never reports, the funder gets the money back after the grace period.
    function reclaim(uint256 id) external nonReentrant {
        Pledge storage p = _pledges[id];
        if (msg.sender != p.funder) revert NotFunder();
        if (p.status != Status.Active) revert BadStatus(p.status);
        if (block.timestamp < uint256(p.seasonEnd) + reportGrace) revert WindowOpen();
        p.status = Status.Refunded;
        _send(payable(p.funder), p.amount);
        emit Settled(id, Status.Refunded, p.funder, p.amount);
    }

    // ---------------------------------------------------------------- oracle

    /// @notice Report season outcome. Must cite a day whose evidence is already anchored on-chain.
    function report(uint256 id, uint32 ignitions, uint16 confidenceBps, uint32 evidenceDay) external onlyOracle {
        Pledge storage p = _pledges[id];
        if (p.status != Status.Active) revert BadStatus(p.status);
        if (block.timestamp < p.seasonEnd) revert SeasonNotOver();
        if (confidenceBps > 10_000) revert BadParams();
        bytes32 root = registry.rootOf(evidenceDay);
        if (root == bytes32(0)) revert EvidenceNotAnchored(evidenceDay);
        p.ignitions = ignitions;
        p.confidenceBps = confidenceBps;
        p.evidenceDay = evidenceDay;
        p.disputeDeadline = uint64(block.timestamp) + disputeWindow;
        p.status = Status.Reported;
        emit Reported(id, ignitions, confidenceBps, evidenceDay, root, p.disputeDeadline);
    }

    // ---------------------------------------------------------------- beneficiary

    function dispute(uint256 id, string calldata uri) external {
        Pledge storage p = _pledges[id];
        if (msg.sender != p.beneficiary) revert NotBeneficiary();
        if (p.status != Status.Reported) revert BadStatus(p.status);
        if (block.timestamp >= p.disputeDeadline) revert WindowClosed();
        p.status = Status.Disputed;
        p.disputeUri = uri;
        emit Disputed(id, uri);
    }

    // ---------------------------------------------------------------- arbiter (owner; a multisig/DAO in production)

    function resolveDispute(uint256 id, uint32 ignitions, uint16 confidenceBps) external onlyOwner nonReentrant {
        Pledge storage p = _pledges[id];
        if (p.status != Status.Disputed) revert BadStatus(p.status);
        if (confidenceBps > 10_000) revert BadParams();
        p.ignitions = ignitions;
        p.confidenceBps = confidenceBps;
        emit DisputeResolved(id, ignitions, confidenceBps);
        _finalize(id, p);
    }

    // ---------------------------------------------------------------- anyone

    /// @notice Anyone can settle once the dispute window has passed without a dispute.
    function settle(uint256 id) external nonReentrant {
        Pledge storage p = _pledges[id];
        if (p.status != Status.Reported) revert BadStatus(p.status);
        if (block.timestamp < p.disputeDeadline) revert WindowOpen();
        _finalize(id, p);
    }

    function _finalize(uint256 id, Pledge storage p) private {
        bool fire = p.ignitions > 0 && p.confidenceBps >= confidenceThresholdBps;
        address payable to = fire ? p.slashPool : p.beneficiary;
        p.status = fire ? Status.Slashed : Status.Paid;
        uint256 amt = p.amount;
        _send(to, amt);
        emit Settled(id, p.status, to, amt);
    }

    function _send(address payable to, uint256 amt) private {
        (bool ok, ) = to.call{value: amt}("");
        if (!ok) revert TransferFailed();
    }

    // ---------------------------------------------------------------- views

    function pledgeCount() external view returns (uint256) { return _pledges.length; }

    function getPledge(uint256 id) external view returns (Pledge memory) { return _pledges[id]; }

    /// @notice Preview what settle() would do right now.
    function wouldSlash(uint256 id) external view returns (bool) {
        Pledge storage p = _pledges[id];
        return p.ignitions > 0 && p.confidenceBps >= confidenceThresholdBps;
    }
}
