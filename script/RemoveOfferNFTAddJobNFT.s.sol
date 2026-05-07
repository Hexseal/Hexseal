// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/DiamondProxy.sol";

/**
 * @notice Remove OfferNFTFacet from Diamond and add JobNFTFacet
 * 
 * This script:
 * 1. Removes all OfferNFTFacet selectors from Diamond
 * 2. Adds JobNFTFacet with its selectors
 * 
 * OfferNFTFacet selectors to remove:
 * - initialize(address) - 0xc4d66de8
 * - mintOffer(...) - 0x0b569cb4
 * - mintOfferWithPermit(...) - 0xfd7926cb
 * - hireAndCreateDeal(...) - 0x5a113042
 * - hireAndCreateDealWithPermit(...) - 0x7dcf9d81
 * - deactivateOffer(uint256) - 0x0b5e1f3f
 * - getOffer(uint256) - 0x4579268a
 * - getExecutorOffers(address) - 0xea2991c2
 * - getOfferHires(uint256) - 0x18955c6d
 * - getActiveOffersCount() - 0x87003901
 * 
 * JobNFTFacet selectors to add:
 * - initialize() - 0x8129fc1c
 * - mintJob(...) - 0xcc63abf7
 * - cancelJob(uint256) - 0x1dffa3dc
 * - applyForJob(uint256) - 0xe0c94ae5
 * - acceptJob(uint256, uint256) - 0x0a3ff40d
 * - startJob(uint256) - 0xe1255294
 * - completeJob(uint256) - 0xa1c0d32f
 * - disputeJob(uint256) - 0xd93d9beb
 * - resolveDispute(uint256, bool) - 0x34b25ee2
 * - getJob(uint256) - 0xbf22c457
 * - getClientJobs(address) - 0xcf2646c2
 * - getExecutorJobs(address) - 0x45f4649f
 * - getJobApplicants(uint256) - 0x04f801a0
 * - getActiveJobsCount() - 0x5b7c278e
 * - getTotalSupply() - 0xc4e41b22
 */
contract RemoveOfferNFTAddJobNFT is Script {
    address DIAMOND = vm.envAddress("DIAMOND_ADDRESS");
    uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
    
    function run() external {
        require(DIAMOND != address(0), "DIAMOND_ADDRESS not set");
        
        console.log("=== REMOVE OFFER NFT FACET, ADD JOB NFT FACET ===");
        console.log("Diamond address:", DIAMOND);
        
        vm.startBroadcast(deployerPrivateKey);
        
        // OfferNFTFacet selectors to remove
        bytes4[] memory offerSelectors = new bytes4[](10);
        offerSelectors[0] = 0xc4d66de8; // initialize(address)
        offerSelectors[1] = 0x0b569cb4; // mintOffer(...)
        offerSelectors[2] = 0xfd7926cb; // mintOfferWithPermit(...)
        offerSelectors[3] = 0x5a113042; // hireAndCreateDeal(...)
        offerSelectors[4] = 0x7dcf9d81; // hireAndCreateDealWithPermit(...)
        offerSelectors[5] = 0x0b5e1f3f; // deactivateOffer(uint256)
        offerSelectors[6] = 0x4579268a; // getOffer(uint256)
        offerSelectors[7] = 0xea2991c2; // getExecutorOffers(address)
        offerSelectors[8] = 0x18955c6d; // getOfferHires(uint256)
        offerSelectors[9] = 0x87003901; // getActiveOffersCount()
        
        // JobNFTFacet selectors to add
        bytes4[] memory jobSelectors = new bytes4[](15);
        jobSelectors[0] = 0x8129fc1c; // initialize()
        jobSelectors[1] = 0xcc63abf7; // mintJob(...)
        jobSelectors[2] = 0x1dffa3dc; // cancelJob(uint256)
        jobSelectors[3] = 0xe0c94ae5; // applyForJob(uint256)
        jobSelectors[4] = 0x0a3ff40d; // acceptJob(uint256, uint256)
        jobSelectors[5] = 0xe1255294; // startJob(uint256)
        jobSelectors[6] = 0xa1c0d32f; // completeJob(uint256)
        jobSelectors[7] = 0xd93d9beb; // disputeJob(uint256)
        jobSelectors[8] = 0x34b25ee2; // resolveDispute(uint256, bool)
        jobSelectors[9] = 0xbf22c457; // getJob(uint256)
        jobSelectors[10] = 0xcf2646c2; // getClientJobs(address)
        jobSelectors[11] = 0x45f4649f; // getExecutorJobs(address)
        jobSelectors[12] = 0x04f801a0; // getJobApplicants(uint256)
        jobSelectors[13] = 0x5b7c278e; // getActiveJobsCount()
        jobSelectors[14] = 0xc4e41b22; // getTotalSupply()
        
        // Prepare diamondCut
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](2);
        
        // Cut 1: Remove OfferNFTFacet selectors
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(0),
            action: IDiamondCut.FacetCutAction.Remove,
            functionSelectors: offerSelectors
        });
        
        // Cut 2: Add JobNFTFacet selectors
        cuts[1] = IDiamondCut.FacetCut({
            facetAddress: address(0), // Will be replaced with actual JobNFTFacet address
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: jobSelectors
        });
        
        console.log("Removing OfferNFTFacet selectors...");
        // Note: We need to deploy JobNFTFacet first, then do the cut
        // For now, just show what would happen
        
        vm.stopBroadcast();
        
        console.log("To complete this operation:");
        console.log("1. Deploy JobNFTFacet contract");
        console.log("2. Run diamondCut with JobNFTFacet address");
        console.log("3. Remove OfferNFTFacet selectors");
    }
}
