// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title EvidenceRegistry
/// @notice Write-once, per-day registry of Merkle roots over satellite fire evidence.
///         Each leaf is SHA-256 of one canonical evidence row (a NASA FIRMS detection,
///         a clustered fire event, or an attribution result). SHA-256 is used instead of
///         keccak so anyone can rebuild a proof in a browser with crypto.subtle, wallet-free.
/// @dev    Internal nodes are sha256(min(a,b) || max(a,b)) (sorted pairs, no index bits).
contract EvidenceRegistry is Ownable {
    struct Anchor {
        bytes32 root;          // Merkle root of the day's evidence rows
        uint32 rowCount;       // number of leaves
        uint64 anchoredAt;     // block timestamp
        address oracle;        // who anchored it
        string dataset;        // e.g. "FIRMS VIIRS_SNPP+NOAA20+NOAA21 NRT | AOI CentralKalimantan"
        string modelVersion;   // e.g. "hazechain-attrib-0.3.0+risk-gbm-2026.10"
        string uri;            // where the full bundle lives (repo path / IPFS CID)
    }

    /// @dev day key = YYYYMMDD (UTC acquisition date of the satellite data)
    mapping(uint32 => Anchor) private _anchors;
    mapping(address => bool) public isOracle;
    uint32[] public anchoredDays;

    event OracleSet(address indexed oracle, bool allowed);
    event Anchored(uint32 indexed day, bytes32 indexed root, uint32 rowCount, address indexed oracle, string modelVersion, string uri);

    error NotOracle();
    error AlreadyAnchored(uint32 day);
    error EmptyRoot();
    error BadDay(uint32 day);

    constructor(address initialOracle) Ownable(msg.sender) {
        isOracle[initialOracle] = true;
        emit OracleSet(initialOracle, true);
    }

    modifier onlyOracle() {
        if (!isOracle[msg.sender]) revert NotOracle();
        _;
    }

    function setOracle(address oracle, bool allowed) external onlyOwner {
        isOracle[oracle] = allowed;
        emit OracleSet(oracle, allowed);
    }

    /// @notice Anchor one day of evidence. Write-once: a day can never be overwritten,
    ///         so neither the operator nor a concession holder can rewrite history later.
    function anchor(
        uint32 day,
        bytes32 root,
        uint32 rowCount,
        string calldata dataset,
        string calldata modelVersion,
        string calldata uri
    ) external onlyOracle {
        if (root == bytes32(0)) revert EmptyRoot();
        if (day < 20000101 || day > 21001231) revert BadDay(day);
        if (_anchors[day].root != bytes32(0)) revert AlreadyAnchored(day);
        _anchors[day] = Anchor(root, rowCount, uint64(block.timestamp), msg.sender, dataset, modelVersion, uri);
        anchoredDays.push(day);
        emit Anchored(day, root, rowCount, msg.sender, modelVersion, uri);
    }

    function getAnchor(uint32 day) external view returns (Anchor memory) {
        return _anchors[day];
    }

    function rootOf(uint32 day) external view returns (bytes32) {
        return _anchors[day].root;
    }

    function anchoredDayCount() external view returns (uint256) {
        return anchoredDays.length;
    }

    /// @notice Check that `leaf` (sha256 of a canonical row) is part of the evidence anchored for `day`.
    function verify(uint32 day, bytes32 leaf, bytes32[] calldata proof) external view returns (bool) {
        bytes32 root = _anchors[day].root;
        if (root == bytes32(0)) return false;
        return processProof(leaf, proof) == root;
    }

    /// @notice Convenience: hash a raw canonical row on-chain and verify it.
    function verifyRow(uint32 day, bytes calldata row, bytes32[] calldata proof) external view returns (bool) {
        bytes32 root = _anchors[day].root;
        if (root == bytes32(0)) return false;
        return processProof(sha256(row), proof) == root;
    }

    function processProof(bytes32 leaf, bytes32[] calldata proof) public pure returns (bytes32 computed) {
        computed = leaf;
        for (uint256 i = 0; i < proof.length; i++) {
            bytes32 p = proof[i];
            computed = computed <= p ? sha256(abi.encodePacked(computed, p)) : sha256(abi.encodePacked(p, computed));
        }
    }
}
