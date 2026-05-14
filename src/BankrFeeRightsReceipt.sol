// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC721} from "openzeppelin-contracts/contracts/token/ERC721/ERC721.sol";
import {Base64} from "openzeppelin-contracts/contracts/utils/Base64.sol";
import {Strings} from "openzeppelin-contracts/contracts/utils/Strings.sol";
import {IERC20Metadata} from "openzeppelin-contracts/contracts/token/ERC20/extensions/IERC20Metadata.sol";

/// @title BankrFeeRightsReceipt
/// @notice ERC721 receipt minted when escrow finalizes custody of Bankr fee rights.
///         Each token has a sequential serial number (#1, #2 …) and a fully on-chain
///         SVG image that shows the token pair, factory, pool, and original seller.
/// @dev Only the escrow contract may mint or burn. The `factoryName` field in Position
///      lets future factories (Bankr, Clanker, …) brand their receipts without
///      redeploying this contract.
contract BankrFeeRightsReceipt is ERC721 {
    /// @notice Metadata stored per minted receipt.
    struct Position {
        address feeManager;
        bytes32 poolId;
        address token0;
        address token1;
        address seller;
        string factoryName; // e.g. "Bankr", "Clanker" — set by escrow at mint time
    }

    address public immutable escrow;

    /// @notice Total receipts ever minted (never decremented on burn).
    uint256 public totalMinted;

    mapping(uint256 tokenId => Position) private _positions;
    /// @notice Sequential 1-based serial number for each tokenId.
    mapping(uint256 tokenId => uint256 serial) private _serials;

    error NotEscrow();
    error ZeroAddress();

    modifier onlyEscrow() {
        if (msg.sender != escrow) revert NotEscrow();
        _;
    }

    constructor(address escrow_) ERC721("Bankr Fee Rights Receipt", "BFRR") {
        if (escrow_ == address(0)) revert ZeroAddress();
        escrow = escrow_;
    }

    // ── Escrow-only mutations ────────────────────────────────────────────────

    function mint(address to, uint256 tokenId, Position calldata position) external onlyEscrow {
        uint256 serial = ++totalMinted;
        _mint(to, tokenId);
        _positions[tokenId] = position;
        _serials[tokenId] = serial;
    }

    function burn(uint256 tokenId) external onlyEscrow {
        _burn(tokenId);
        delete _positions[tokenId];
        delete _serials[tokenId];
    }

    // ── Views ────────────────────────────────────────────────────────────────

    function positionOf(uint256 tokenId) external view returns (Position memory) {
        return _positions[tokenId];
    }

    function serialOf(uint256 tokenId) external view returns (uint256) {
        return _serials[tokenId];
    }

    // ── ERC721 metadata ──────────────────────────────────────────────────────

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        ownerOf(tokenId); // reverts ERC721NonexistentToken if burned / never minted
        Position memory pos = _positions[tokenId];
        uint256 serial = _serials[tokenId];

        string memory sym0 = _trySymbol(pos.token0);
        string memory sym1 = _trySymbol(pos.token1);
        string memory fact = bytes(pos.factoryName).length > 0 ? pos.factoryName : "Unknown";
        string memory sSerial = Strings.toString(serial);

        string memory svg = _buildSVG(pos, sSerial, sym0, sym1, fact);

        string memory json = string.concat(
            '{"name":"BFRR #',
            sSerial,
            '",',
            '"description":"Bankr Fee Rights Receipt \u2014 ',
            _safe(sym0),
            "/",
            _safe(sym1),
            " on Base\",",
            '"image":"data:image/svg+xml;base64,',
            Base64.encode(bytes(svg)),
            '",',
            '"attributes":[',
            '{"trait_type":"Serial","value":',
            sSerial,
            "},",
            '{"trait_type":"Factory","value":"',
            _safe(fact),
            '"},',
            '{"trait_type":"Pair","value":"',
            _safe(sym0),
            "/",
            _safe(sym1),
            '"},',
            '{"trait_type":"Original Seller","value":"',
            Strings.toHexString(pos.seller),
            '"},',
            '{"trait_type":"Fee Manager","value":"',
            Strings.toHexString(pos.feeManager),
            '"}',
            "]}"
        );

        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
    }

    // ── SVG construction ─────────────────────────────────────────────────────

    function _buildSVG(
        Position memory pos,
        string memory sSerial,
        string memory sym0,
        string memory sym1,
        string memory fact
    ) private pure returns (string memory) {
        return string.concat(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 260">',
            _svgDefs(),
            _svgFrame(fact),
            _svgHeader(sSerial, sym0, sym1),
            _svgBody(pos, sSerial),
            "</svg>"
        );
    }

    function _svgDefs() private pure returns (string memory) {
        return string.concat(
            "<defs>",
            '<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">',
            '<stop offset="0" stop-color="#0a0a0a"/>',
            '<stop offset="1" stop-color="#130f1f"/>',
            "</linearGradient>",
            "</defs>"
        );
    }

    function _svgFrame(string memory fact) private pure returns (string memory) {
        return string.concat(
            '<rect width="400" height="260" fill="url(#bg)" rx="16"/>',
            '<rect x="1" y="1" width="398" height="258" rx="15" fill="none"',
            ' stroke="#f97316" stroke-width="1" stroke-opacity="0.3"/>',
            // Factory badge — top-right corner
            '<rect x="287" y="15" width="98" height="26" rx="13"',
            ' fill="#f97316" fill-opacity="0.1" stroke="#f97316"',
            ' stroke-width="0.75" stroke-opacity="0.45"/>',
            '<text x="336" y="33" font-family="monospace" font-size="11"',
            ' fill="#f97316" text-anchor="middle" font-weight="700" letter-spacing="1.5">',
            _toUpper(fact),
            "</text>"
        );
    }

    function _svgHeader(string memory sSerial, string memory sym0, string memory sym1)
        private
        pure
        returns (string memory)
    {
        return string.concat(
            '<text x="24" y="62" font-family="monospace" font-size="30"',
            ' fill="#ffffff" font-weight="700">BFRR #',
            sSerial,
            "</text>",
            '<text x="24" y="90" font-family="monospace" font-size="17"',
            ' fill="#f97316" font-weight="600">',
            _safe(sym0),
            " / ",
            _safe(sym1),
            "</text>",
            '<line x1="24" y1="108" x2="376" y2="108" stroke="#222" stroke-width="1"/>'
        );
    }

    function _svgBody(Position memory pos, string memory sSerial) private pure returns (string memory) {
        return string.concat(
            _svgRow("128", "POOL", _shortB32(pos.poolId)),
            _svgRow("152", "SELLER", _shortAddr(pos.seller)),
            _svgRow("176", "FEE MGR", _shortAddr(pos.feeManager)),
            '<line x1="24" y1="200" x2="376" y2="200" stroke="#222" stroke-width="1"/>',
            '<text x="24" y="220" font-family="monospace" font-size="9" fill="#444">',
            "Bankr Fee Rights Receipt - Base</text>",
            '<text x="376" y="220" font-family="monospace" font-size="9"',
            ' fill="#444" text-anchor="end">#',
            sSerial,
            "</text>"
        );
    }

    function _svgRow(string memory y, string memory label, string memory value)
        private
        pure
        returns (string memory)
    {
        return string.concat(
            '<text x="24" y="',
            y,
            '" font-family="monospace" font-size="10" fill="#555">',
            label,
            "</text>",
            '<text x="100" y="',
            y,
            '" font-family="monospace" font-size="10" fill="#aaa">',
            value,
            "</text>"
        );
    }

    // ── String utilities ─────────────────────────────────────────────────────

    /// @dev Attempts to read the ERC-20 symbol; falls back to a short address on failure.
    function _trySymbol(address token) private view returns (string memory) {
        try IERC20Metadata(token).symbol() returns (string memory s) {
            return bytes(s).length > 0 ? s : _shortAddr(token);
        } catch {
            return _shortAddr(token);
        }
    }

    /// @dev "0x" + first 4 hex + "..." + last 4 hex  (13 chars total).
    function _shortAddr(address addr) private pure returns (string memory) {
        string memory full = Strings.toHexString(addr); // "0x" + 40 chars = 42
        bytes memory b = bytes(full);
        bytes memory out = new bytes(13);
        out[0] = b[0];
        out[1] = b[1]; // "0x"
        out[2] = b[2];
        out[3] = b[3];
        out[4] = b[4];
        out[5] = b[5]; // first 4 hex
        out[6] = ".";
        out[7] = ".";
        out[8] = ".";
        out[9] = b[38];
        out[10] = b[39];
        out[11] = b[40];
        out[12] = b[41]; // last 4 hex
        return string(out);
    }

    /// @dev "0x" + first 4 hex + "..." + last 4 hex for a bytes32.
    function _shortB32(bytes32 b32) private pure returns (string memory) {
        string memory full = Strings.toHexString(uint256(b32), 32); // "0x" + 64 chars = 66
        bytes memory b = bytes(full);
        bytes memory out = new bytes(13);
        out[0] = b[0];
        out[1] = b[1];
        out[2] = b[2];
        out[3] = b[3];
        out[4] = b[4];
        out[5] = b[5];
        out[6] = ".";
        out[7] = ".";
        out[8] = ".";
        out[9] = b[62];
        out[10] = b[63];
        out[11] = b[64];
        out[12] = b[65];
        return string(out);
    }

    /// @dev Strips / replaces characters that would break SVG or JSON.
    ///      Truncates to 12 chars max.
    function _safe(string memory s) private pure returns (string memory) {
        bytes memory b = bytes(s);
        uint256 len = b.length > 12 ? 12 : b.length;
        bytes memory out = new bytes(len);
        for (uint256 i = 0; i < len; i++) {
            bytes1 c = b[i];
            if (c == "<" || c == ">" || c == "&" || c == '"' || c == "'" || c == "\\") {
                out[i] = "?";
            } else {
                out[i] = c;
            }
        }
        return string(out);
    }

    /// @dev ASCII-only uppercase. Truncates to 12 chars.
    function _toUpper(string memory s) private pure returns (string memory) {
        bytes memory b = bytes(s);
        uint256 len = b.length > 12 ? 12 : b.length;
        bytes memory out = new bytes(len);
        for (uint256 i = 0; i < len; i++) {
            bytes1 c = b[i];
            out[i] = (c >= 0x61 && c <= 0x7a) ? bytes1(uint8(c) - 32) : c;
        }
        return string(out);
    }
}
