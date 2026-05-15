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
    address private constant WETH_BASE = 0x4200000000000000000000000000000000000006;

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
        string memory ticker = _launchedTicker(pos, sym0, sym1);
        string memory tokenName = _launchedTokenName(pos, sym0, sym1);
        string memory fact = bytes(pos.factoryName).length > 0 ? pos.factoryName : "Unknown";
        string memory sSerial = Strings.toString(serial);

        string memory svg = _buildSVG(pos, sSerial, ticker, tokenName, fact);

        string memory json = _encodeTokenMetadataJson(pos, sSerial, ticker, tokenName, fact, svg);

        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
    }

    /// @dev Split from `tokenURI` to avoid IR stack-too-deep.
    function _encodeTokenMetadataJson(
        Position memory pos,
        string memory sSerial,
        string memory ticker,
        string memory tokenName,
        string memory fact,
        string memory svg
    ) private pure returns (string memory) {
        string memory head = string.concat(
            '{"name":"Bankr Fee Rights #',
            sSerial,
            '",',
            '"description":"',
            _safe(fact),
            " fee rights on Base: ",
            _safe(ticker),
            " (",
            _safe(tokenName),
            "). Pool ",
            _shortB32(pos.poolId),
            ". Seller ",
            _shortAddr(pos.seller),
            '."',
            ',"image":"data:image/svg+xml;base64,',
            Base64.encode(bytes(svg)),
            '",',
            '"attributes":['
        );
        string memory tail = string.concat(
            '{"trait_type":"Serial","value":',
            sSerial,
            "},",
            '{"trait_type":"Factory","value":"',
            _safe(fact),
            '"},',
            '{"trait_type":"Ticker","value":"',
            _safe(ticker),
            '"},',
            '{"trait_type":"Token Name","value":"',
            _safe(tokenName),
            '"},',
            '{"trait_type":"Pair","value":"',
            _safe(ticker),
            '"},',
            '{"trait_type":"Original Seller","value":"',
            Strings.toHexString(pos.seller),
            '"},',
            '{"trait_type":"Fee Manager","value":"',
            Strings.toHexString(pos.feeManager),
            '"}',
            "]}"
        );
        return string.concat(head, tail);
    }

    // ── SVG construction ─────────────────────────────────────────────────────

    function _buildSVG(
        Position memory pos,
        string memory sSerial,
        string memory ticker,
        string memory tokenName,
        string memory fact
    ) private pure returns (string memory) {
        bool compactLayout = keccak256(bytes(_safe(ticker))) == keccak256(bytes(_safe(tokenName)));
        return string.concat(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 420 300">',
            _svgDefs(),
            _svgFrame(fact),
            _svgHeader(sSerial, ticker, tokenName),
            _svgBody(pos, sSerial, compactLayout),
            "</svg>"
        );
    }

    function _svgDefs() private pure returns (string memory) {
        return string.concat(
            "<defs>",
            '<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">',
            '<stop offset="0" stop-color="#050508"/>',
            '<stop offset="0.5" stop-color="#0f0f14"/>',
            '<stop offset="1" stop-color="#1a0f18"/>',
            "</linearGradient>",
            '<linearGradient id="chip" x1="0" y1="0" x2="1" y2="0">',
            '<stop offset="0" stop-color="#fb923c"/>',
            '<stop offset="1" stop-color="#ea580c"/>',
            "</linearGradient>",
            "</defs>"
        );
    }

    function _svgFrame(string memory fact) private pure returns (string memory) {
        return string.concat(
            '<rect width="420" height="300" fill="url(#bg)" rx="20"/>',
            '<circle cx="332" cy="228" r="118" fill="#f97316" fill-opacity="0.07"/>',
            '<circle cx="64" cy="256" r="76" fill="#7c3aed" fill-opacity="0.045"/>',
            '<rect x="1" y="1" width="418" height="298" rx="19" fill="none" stroke="#3f3f46" stroke-opacity="0.85" stroke-width="1"/>',
            '<rect x="18" y="48" width="384" height="236" rx="16" fill="#09090b" stroke="#f97316" stroke-opacity="0.25" stroke-width="1"/>',
            '<rect x="286" y="58" width="100" height="28" rx="14" fill="url(#chip)" fill-opacity="0.18" stroke="#fdba74" stroke-opacity="0.45"/>',
            '<text x="336" y="77" font-family="ui-monospace,monospace" font-size="10" fill="#fff7ed" text-anchor="middle" font-weight="700" letter-spacing="1.1">',
            _toUpper(fact),
            "</text>"
        );
    }

    function _svgHeader(string memory sSerial, string memory ticker, string memory tokenName)
        private
        pure
        returns (string memory)
    {
        bool showName = keccak256(bytes(_safe(ticker))) != keccak256(bytes(_safe(tokenName)));
        string memory boxH = showName ? "58" : "48";
        string memory lineY = showName ? "200" : "194";
        return string.concat(
            '<text x="32" y="82" font-family="ui-monospace,monospace" font-size="12" fill="#a1a1aa" font-weight="600">BANKR FEE RIGHTS</text>',
            '<text x="32" y="118" font-family="ui-monospace,monospace" font-size="30" fill="#fafafa" font-weight="800">BFRR #',
            sSerial,
            "</text>",
            '<rect x="32" y="130" width="356" height="',
            boxH,
            '" rx="12" fill="#18181b" stroke="#27272f" stroke-width="1"/>',
            '<text x="48" y="152" font-family="ui-monospace,monospace" font-size="9" fill="#71717a" font-weight="600">TICKER</text>',
            '<text x="48" y="172" font-family="ui-monospace,monospace" font-size="20" fill="#fdba74" font-weight="700">',
            _safe(ticker),
            "</text>",
            showName
                ? string.concat(
                    '<text x="210" y="152" font-family="ui-monospace,monospace" font-size="9" fill="#71717a" font-weight="600">TOKEN NAME</text>',
                    '<text x="210" y="172" font-family="ui-monospace,monospace" font-size="14" fill="#e4e4e7" font-weight="600">',
                    _safe(tokenName),
                    "</text>"
                )
                : "",
            '<line x1="32" y1="',
            lineY,
            '" x2="388" y2="',
            lineY,
            '" stroke="#27272f" stroke-width="1"/>'
        );
    }

    function _svgBody(Position memory pos, string memory sSerial, bool compact) private pure returns (string memory) {
        string memory yPool = compact ? "210" : "218";
        string memory ySell = compact ? "234" : "242";
        string memory yFee = compact ? "258" : "266";
        return string.concat(
            _svgRow(yPool, "POOL ID", _shortB32(pos.poolId)),
            _svgRow(ySell, "SELLER", _shortAddr(pos.seller)),
            _svgRow(yFee, "FEE MGR", _shortAddr(pos.feeManager)),
            '<line x1="32" y1="278" x2="388" y2="278" stroke="#27272f" stroke-width="1"/>',
            '<text x="32" y="292" font-family="ui-monospace,monospace" font-size="9" fill="#52525b">Bankr Fee Rights Receipt - Base mainnet</text>',
            '<text x="388" y="292" font-family="ui-monospace,monospace" font-size="9" fill="#52525b" text-anchor="end">#',
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
            '<text x="32" y="',
            y,
            '" font-family="ui-monospace,monospace" font-size="10" fill="#71717a" font-weight="600">',
            label,
            "</text>",
            '<text x="118" y="',
            y,
            '" font-family="ui-monospace,monospace" font-size="10" fill="#e4e4e7">',
            value,
            "</text>"
        );
    }

    // ── Launched-token labels (WETH leg hidden) ───────────────────────────────

    function _launchedTicker(Position memory pos, string memory sym0, string memory sym1)
        private
        pure
        returns (string memory)
    {
        if (pos.token0 == WETH_BASE) return sym1;
        if (pos.token1 == WETH_BASE) return sym0;
        return sym0;
    }

    function _launchedTokenName(Position memory pos, string memory sym0, string memory sym1)
        private
        view
        returns (string memory)
    {
        if (pos.token0 == WETH_BASE) return _launchedName(pos.token1, sym1);
        if (pos.token1 == WETH_BASE) return _launchedName(pos.token0, sym0);
        return sym1;
    }

    function _launchedName(address token, string memory fallbackSym) private view returns (string memory) {
        try IERC20Metadata(token).name() returns (string memory n) {
            if (bytes(n).length == 0) return fallbackSym;
            if (_isWethLabel(n)) return fallbackSym;
            return n;
        } catch {
            return fallbackSym;
        }
    }

    function _isWethLabel(string memory s) private pure returns (bool) {
        return keccak256(bytes(_toUpper(s))) == keccak256(bytes("WETH"))
            || keccak256(bytes(_toUpper(s))) == keccak256(bytes("WRAPPED ETHER"));
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
