const logger = require('./logger');
const {prisma} = require('./prisma');
const ethers = require('ethers');
const crypto = require('crypto');

const FEED_COUNT_SUBMISSION_SIZE = 10;

async function submitProvPerformance (BC_NODE_URL, BC_PRICE_ORACLE_PRIVATE_KEY, BC_PRICE_ORACLE_MANAGER_CONTRACT, provMap) {
    try {
        const lastRunRec = await prisma.provider_performance.findFirst({
            orderBy: {
                created_datetime: 'desc'
            }
        });
        const lastRunTimestamp = lastRunRec? lastRunRec.created_datetime: new Date('2024-01-01');
        logger.info('lastRunTimestamp: ', lastRunTimestamp);
        
        var providerList = [];
        var feedCountList = [];
        for(let prov in provMap) {
            let recs = await prisma.feed_submission.findMany({
                where: {
                    AND: {
                        created_datetime: {
                            gte: lastRunTimestamp
                        },
                        feed_provider_id: provMap[prov].id
                    }
                }
            });
            if (recs) {
                providerList.push(prov);
                feedCountList.push(recs.length);
            }
        }

        const provider = new ethers.providers.JsonRpcProvider(BC_NODE_URL);
        const signer = new ethers.Wallet(BC_PRICE_ORACLE_PRIVATE_KEY, provider);
        let dateNow = new Date();
        let now = Math.floor(dateNow.getTime() / 1000);

        let oracleManagerContractABI = [
            "function submitProviderFeedCount(address[10],uint256[10],uint256) external"
        ];
        let oracleManagerContract = new ethers.Contract(
            BC_PRICE_ORACLE_MANAGER_CONTRACT,
            oracleManagerContractABI,
            signer
        );

        let totalRec = providerList.length;
        let newProviderPerformances = [];

        // submit number of providers per trx based on FEED_COUNT_SUBMISSION_SIZE
        for(var i=0; i < Math.ceil(totalRec / FEED_COUNT_SUBMISSION_SIZE); i++) {
            let endIndex = (i*FEED_COUNT_SUBMISSION_SIZE) + FEED_COUNT_SUBMISSION_SIZE;
            if (endIndex > totalRec)
                endIndex = totalRec;
            let subProvList = providerList.slice(i*FEED_COUNT_SUBMISSION_SIZE, endIndex);
            let subFeedCountList = feedCountList.slice(i*FEED_COUNT_SUBMISSION_SIZE, endIndex);
            if (subProvList.length != subFeedCountList.length) {
                logger.error('Unmatched list length '+subProvList.length+' vs '+subFeedCountList.length);
                return {error: 'Internal server error: unmatched list size'};
            }

            // Fill up unused slot(s)
            for (var n=subProvList.length; n < FEED_COUNT_SUBMISSION_SIZE; n++) {
                subProvList.push(ethers.constants.AddressZero);
                subFeedCountList.push(0);
            }

            var data = oracleManagerContract.interface.encodeFunctionData('submitProviderFeedCount', [
                subProvList,
                subFeedCountList,
                now
            ]);
            var transaction = {
                to: BC_PRICE_ORACLE_MANAGER_CONTRACT,
                data: data,
                gasLimit: 10000000 // 10m
            };
            const tx = await signer.sendTransaction(transaction);
            const receipt = await tx.wait();
            logger.info("Provider performance is submitted! Round: "+i+' TX: '+receipt.transactionHash);

            const newProviderPerformance = await prisma.provider_performance.create({
                data: {
                    id: crypto.randomUUID(),
                    created_datetime: dateNow.toISOString(),
                    provider_count: totalRec,
                    providers: subProvList.toString(),
                    feed_counts: subFeedCountList.toString(),
                    trx_ref: receipt.transactionHash
                }
            });
            logger.info('Created provider performance record: ' + newProviderPerformance.id);
            newProviderPerformances.push(newProviderPerformance);
        }

        return {
            newProviderPerformances: newProviderPerformances
        };

    } catch (error) {
        logger.error(error);
    }
};


exports.providerPerformanceJob = {
    submitProvPerformance
}