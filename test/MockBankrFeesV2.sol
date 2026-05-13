// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";
import {IBankrFees} from "../src/interfaces/IBankrFees.sol";

contract MockERC20 is ERC20 {
    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice Fee-manager double that can return values different from actual transferred assets.
contract MockBankrFeesManagerV2 is IBankrFees {
    MockERC20 public immutable token0;
    MockERC20 public immutable token1;

    mapping(bytes32 poolId => mapping(address beneficiary => uint256 shares)) private _shares;
    mapping(bytes32 poolId => mapping(address beneficiary => uint256 lastActualFees0)) private _lastActualFees0;
    mapping(bytes32 poolId => mapping(address beneficiary => uint256 lastActualFees1)) private _lastActualFees1;
    mapping(bytes32 poolId => mapping(address beneficiary => uint256 lastReportedFees0)) private _lastReportedFees0;
    mapping(bytes32 poolId => mapping(address beneficiary => uint256 lastReportedFees1)) private _lastReportedFees1;

    mapping(bytes32 poolId => uint256 amount) public actualCumulatedFees0;
    mapping(bytes32 poolId => uint256 amount) public actualCumulatedFees1;
    mapping(bytes32 poolId => uint256 amount) public reportedCumulatedFees0;
    mapping(bytes32 poolId => uint256 amount) public reportedCumulatedFees1;

    bool public noOpTransfers;

    error NotBeneficiary();
    error ZeroAddress();

    constructor(MockERC20 token0_, MockERC20 token1_) {
        token0 = token0_;
        token1 = token1_;
    }

    function setNoOpTransfers(bool noOpTransfers_) external {
        noOpTransfers = noOpTransfers_;
    }

    function seedBeneficiary(bytes32 poolId, address beneficiary, uint256 shares_) external {
        if (beneficiary == address(0)) revert ZeroAddress();
        _shares[poolId][beneficiary] = shares_;
    }

    function accrueFees(
        bytes32 poolId,
        uint256 actualFees0,
        uint256 actualFees1,
        uint256 reportedFees0,
        uint256 reportedFees1
    ) external {
        actualCumulatedFees0[poolId] += actualFees0;
        actualCumulatedFees1[poolId] += actualFees1;
        reportedCumulatedFees0[poolId] += reportedFees0;
        reportedCumulatedFees1[poolId] += reportedFees1;

        token0.mint(address(this), actualFees0);
        token1.mint(address(this), actualFees1);
    }

    function updateBeneficiary(bytes32 poolId, address newBeneficiary) external {
        if (newBeneficiary == address(0)) revert ZeroAddress();

        uint256 currentShares = _shares[poolId][msg.sender];
        if (currentShares == 0) revert NotBeneficiary();

        if (noOpTransfers) return;

        _shares[poolId][msg.sender] = 0;
        _shares[poolId][newBeneficiary] = currentShares;

        _lastActualFees0[poolId][newBeneficiary] = _lastActualFees0[poolId][msg.sender];
        _lastActualFees1[poolId][newBeneficiary] = _lastActualFees1[poolId][msg.sender];
        _lastReportedFees0[poolId][newBeneficiary] = _lastReportedFees0[poolId][msg.sender];
        _lastReportedFees1[poolId][newBeneficiary] = _lastReportedFees1[poolId][msg.sender];

        delete _lastActualFees0[poolId][msg.sender];
        delete _lastActualFees1[poolId][msg.sender];
        delete _lastReportedFees0[poolId][msg.sender];
        delete _lastReportedFees1[poolId][msg.sender];
    }

    function collectFees(bytes32 poolId) external returns (uint256 fees0, uint256 fees1) {
        uint256 currentShares = _shares[poolId][msg.sender];
        if (currentShares == 0) revert NotBeneficiary();

        uint256 actualFees0 =
            ((actualCumulatedFees0[poolId] - _lastActualFees0[poolId][msg.sender]) * currentShares) / 1e18;
        uint256 actualFees1 =
            ((actualCumulatedFees1[poolId] - _lastActualFees1[poolId][msg.sender]) * currentShares) / 1e18;

        fees0 = ((reportedCumulatedFees0[poolId] - _lastReportedFees0[poolId][msg.sender]) * currentShares) / 1e18;
        fees1 = ((reportedCumulatedFees1[poolId] - _lastReportedFees1[poolId][msg.sender]) * currentShares) / 1e18;

        _lastActualFees0[poolId][msg.sender] = actualCumulatedFees0[poolId];
        _lastActualFees1[poolId][msg.sender] = actualCumulatedFees1[poolId];
        _lastReportedFees0[poolId][msg.sender] = reportedCumulatedFees0[poolId];
        _lastReportedFees1[poolId][msg.sender] = reportedCumulatedFees1[poolId];

        if (actualFees0 != 0) token0.transfer(msg.sender, actualFees0);
        if (actualFees1 != 0) token1.transfer(msg.sender, actualFees1);
    }

    function getShares(bytes32 poolId, address beneficiary) external view returns (uint256) {
        return _shares[poolId][beneficiary];
    }

    function getCumulatedFees0(bytes32 poolId) external view returns (uint256) {
        return reportedCumulatedFees0[poolId];
    }

    function getCumulatedFees1(bytes32 poolId) external view returns (uint256) {
        return reportedCumulatedFees1[poolId];
    }

    function getLastCumulatedFees0(bytes32 poolId, address beneficiary) external view returns (uint256) {
        return _lastReportedFees0[poolId][beneficiary];
    }

    function getLastCumulatedFees1(bytes32 poolId, address beneficiary) external view returns (uint256) {
        return _lastReportedFees1[poolId][beneficiary];
    }
}
