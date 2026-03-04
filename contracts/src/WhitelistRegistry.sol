// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title WhitelistRegistry
/// @notice On-chain token whitelist for Clawlett agent wallets.
///         Owned by the Gnosis Safe — only the Safe can add/remove tokens.
///         ZodiacHelpersV3 reads this registry via external STATICCALL during cowPreSign().
///
/// @dev This contract stores the whitelist in its OWN storage (not the Safe's).
///      Because ZodiacHelpers calls this via a normal external call (not delegatecall),
///      storage isolation is guaranteed. The agent cannot modify this registry because
///      only the owner (Safe) can call addToken/removeToken.
contract WhitelistRegistry {
    // ========================================================================
    // State
    // ========================================================================

    address public owner;
    mapping(address => bool) public whitelisted;
    address[] public tokenList;

    // ========================================================================
    // Events
    // ========================================================================

    event TokenAdded(address indexed token);
    event TokenRemoved(address indexed token);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    // ========================================================================
    // Errors
    // ========================================================================

    error NotOwner();
    error AlreadyWhitelisted();
    error NotWhitelisted();
    error ZeroAddress();

    // ========================================================================
    // Modifiers
    // ========================================================================

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    // ========================================================================
    // Constructor
    // ========================================================================

    /// @param _owner The Safe address that owns this registry
    /// @param _initialTokens Initial set of whitelisted token addresses
    constructor(address _owner, address[] memory _initialTokens) {
        if (_owner == address(0)) revert ZeroAddress();
        owner = _owner;

        for (uint256 i = 0; i < _initialTokens.length; i++) {
            if (_initialTokens[i] != address(0) && !whitelisted[_initialTokens[i]]) {
                whitelisted[_initialTokens[i]] = true;
                tokenList.push(_initialTokens[i]);
                emit TokenAdded(_initialTokens[i]);
            }
        }
    }

    // ========================================================================
    // Admin: Add / Remove tokens (onlyOwner = Safe)
    // ========================================================================

    /// @notice Add a single token to the whitelist. Only callable by the Safe.
    function addToken(address token) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        if (whitelisted[token]) revert AlreadyWhitelisted();

        whitelisted[token] = true;
        tokenList.push(token);
        emit TokenAdded(token);
    }

    /// @notice Remove a single token from the whitelist. Only callable by the Safe.
    function removeToken(address token) external onlyOwner {
        if (!whitelisted[token]) revert NotWhitelisted();

        whitelisted[token] = false;

        // Swap-and-pop from the array
        for (uint256 i = 0; i < tokenList.length; i++) {
            if (tokenList[i] == token) {
                tokenList[i] = tokenList[tokenList.length - 1];
                tokenList.pop();
                break;
            }
        }

        emit TokenRemoved(token);
    }

    /// @notice Add multiple tokens in one call. Skips duplicates silently.
    function addTokens(address[] calldata tokens) external onlyOwner {
        for (uint256 i = 0; i < tokens.length; i++) {
            if (tokens[i] != address(0) && !whitelisted[tokens[i]]) {
                whitelisted[tokens[i]] = true;
                tokenList.push(tokens[i]);
                emit TokenAdded(tokens[i]);
            }
        }
    }

    // ========================================================================
    // Views
    // ========================================================================

    /// @notice Check if a token is whitelisted. Called by ZodiacHelpersV3.
    function isWhitelisted(address token) external view returns (bool) {
        return whitelisted[token];
    }

    /// @notice Get all whitelisted tokens.
    function getAllTokens() external view returns (address[] memory) {
        return tokenList;
    }

    /// @notice Get the number of whitelisted tokens.
    function getTokenCount() external view returns (uint256) {
        return tokenList.length;
    }

    // ========================================================================
    // Ownership
    // ========================================================================

    /// @notice Transfer ownership to a new address (e.g., new Safe).
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }
}
