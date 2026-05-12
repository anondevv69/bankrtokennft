// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {TestFeeToken} from "../src/TestFeeToken.sol";

contract TestFeeTokenTest is Test {
    address private constant DEPLOYER = address(0xD3F10);
    address private constant RECIPIENT = address(0xB0B);

    function testConstructorMintsInitialSupplyToDeployer() public {
        vm.prank(DEPLOYER);
        TestFeeToken token = new TestFeeToken(1_000_000 ether);

        assertEq(token.name(), "TestFeeToken");
        assertEq(token.symbol(), "TFT");
        assertEq(token.decimals(), 18);
        assertEq(token.totalSupply(), 1_000_000 ether);
        assertEq(token.balanceOf(DEPLOYER), 1_000_000 ether);
    }

    function testStandardTransfersWork() public {
        vm.prank(DEPLOYER);
        TestFeeToken token = new TestFeeToken(1_000_000 ether);

        vm.prank(DEPLOYER);
        token.transfer(RECIPIENT, 100 ether);

        assertEq(token.balanceOf(DEPLOYER), 999_900 ether);
        assertEq(token.balanceOf(RECIPIENT), 100 ether);
    }
}
