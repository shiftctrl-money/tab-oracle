const logger = require('./logger');
const {prisma} = require('./prisma');
const ethers = require('ethers');
const crypto = require('crypto');
const axios = require('axios');

const TOKEN_DECIMAL = 18;
const MEDIUM_PRICE_VALIDITY_WITHIN_SEC = (60 * 5); // price is valid only if it is sent within 5 minutes
const MEDIUM_POOL_SIZE = 9;
const MEDIUM_MIN_FEED_COUNT = 3;
const TAB_SUBMISSION_SIZE = 10; // on-chain function accepts `TabPool[10] calldata _tabPool`
const ZERO = ethers.BigNumber.from('0');

function getRandomInt(min, max) {
    min = Math.ceil(min);
    max = Math.floor(max);
    return Math.floor(Math.random() * (max - min) + min); // The maximum is exclusive and the minimum is inclusive
}

function getMedianValue(values) {
    let midIndex = Math.floor(values.length / 2);
    if (midIndex == 0)
        return values[0].price;
    else {
        if (values.length % 2 == 0) {
            // (mid_left + mid_right) / 2
            // e.g. [2, 4, 6, 8] 
            // return (4 + 6) / 2
            let sumOf2MidItems = values[midIndex - 1].price.add(values[midIndex].price);
            return sumOf2MidItems.div(ethers.BigNumber.from('2'));
        } else {
            return values[midIndex].price;
        }
    }
}

function getBigNumberList(items) {
    let bn = [];
    for(let n=0; n < items.length; n++)
        bn.push(items[n].price);
    return bn;
}

async function submitTrx_tab(strTab, strMode, signer, tabRegistryContractAddr, tabRegistryContract) {
    let data;
    let tab = ethers.utils.hexDataSlice(ethers.utils.formatBytes32String(strTab), 0, 3);
    if (strMode == 'enable') {
        data = tabRegistryContract.interface.encodeFunctionData('enableTab', [tab]);

    } else { // 'disable'
        data = tabRegistryContract.interface.encodeFunctionData('disableTab', [tab]);
    }
    let transaction = {
        to: tabRegistryContractAddr,
        data: data,
        gasLimit: 10000000 // 10m
    };
    let tx = await signer.sendTransaction(transaction);
    let receipt = await tx.wait();
    logger.info(strMode+" tab trx hash: "+receipt.transactionHash);
}

// refer https://nft.storage/api-docs/
async function uploadIPFS(NFT_STORAGE_API_KEY, jsonContent) {
    if (jsonContent.ORACLE_FEEDS.length == 0) {
        logger.error("Skipped IPFS upload: Empty ORACLE_FEEDS content.");
        return '';
    }

    var config = {
        method: 'post',
        maxBodyLength: Infinity,
        url: 'https://api.nft.storage/upload',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${NFT_STORAGE_API_KEY}`
        },
        data: JSON.stringify(jsonContent)
    };
    var cid = '';
    logger.info('Ready to upload...');
    await axios.request(config)
        .then((response) => {
            var res = response.data;
            cid = res.value.cid;
            console.log(res);
            logger.info('Uploaded is completed. CIDv1: '+ cid);
        })
        .catch((error) => {
            logger.error(error);
        });
    return cid;
}

async function getLiveMedianPrices(bRequiredDetails) {
    try {
        const lastMedianBatch = await prisma.median_batch.findFirst({
            where: {
                batch_interval_sec: {
                    equals: (60 * 5)
                }
            },
            orderBy: {
                created_datetime: 'desc'
            },
            include: {
                median_price: true
            }
        });
        if (!lastMedianBatch)
            return {error: 'No data'};
        let batch = {};
        batch.timestamp = lastMedianBatch.created_datetime.getTime();
        batch.cid_v1 = lastMedianBatch.cid;
        batch.transaction_hash = lastMedianBatch.trx_ref;
        batch.base = 'BTC';
        let quotes = {};
        let prices = lastMedianBatch.median_price;
        for(let i=0; i < prices.length; i++) {
            let pair = prices[i].base_currency + prices[i].pair_name;
            quotes[pair] = {
                median: prices[i].median_value
            }
            if (bRequiredDetails) {
                let detailList = [];
                for(let n=0; n < prices[i].active_slot; n++) {
                    let slotName = 'slot_'+n;
                    let pricePairId = prices[i][slotName];
                    let pricePairRec = await prisma.price_pair.findUnique({
                        where: {
                            id: pricePairId
                        },
                        select: {
                            price: true,
                            feed_submission: {
                                select: {
                                    feed_provider: {
                                        select: {
                                            pub_address: true
                                        }
                                    }
                                }
                            }
                        }
                    });
                    if (pricePairRec) {
                        detailList[n] = {
                            'provider': pricePairRec.feed_submission.feed_provider.pub_address,
                            'quote': pricePairRec.price
                        }
                    }
                }
                quotes[pair].details = detailList;
            }
        }
        let data = {
            'quotes': quotes
        };
        batch.data = data;
        return batch;
    } catch(error) {
        logger.error(error);
        return {error: 'Internal server error'};
    }
};

async function groupAndSendMedianPrices (BC_NODE_URL, BC_PRICE_ORACLE_PRIVATE_KEY, BC_KEEPER_PRIVATE_KEY, BC_PRICE_ORACLE_MANAGER_CONTRACT, BC_TAB_REGISTRY_CONTRACT, NFT_STORAGE_API_KEY) {
    const BigNumber = ethers.BigNumber;
    try {
        let providerSnapshotJson = JSON.parse('{"ORACLE_FEEDS":[]}');
        let dateNow = new Date();
        let now = Math.floor(dateNow.getTime() / 1000);

        let validWithin = dateNow.getTime() - (MEDIUM_PRICE_VALIDITY_WITHIN_SEC * 1000);
        
        let lastMedianBatch = await prisma.median_batch.findFirst({
            orderBy: {
                created_datetime: 'desc'
            }
        });
        let lastExecDateTime = new Date('2024-03-18T03:28:05.635Z');
        if (lastMedianBatch)
            lastExecDateTime = lastMedianBatch.created_datetime;
        logger.info("Retrieving feed submission older than "+lastExecDateTime.toISOString());

        let recs = await prisma.$queryRaw`select
        fs2.feed_provider_id,
        fp.pub_address,
        fs2.json_content,
        pp.id,
        pp.pair_name ,
        pp.price 
    from
        feed_submission fs2,
        feed_provider fp,
        price_pair pp
    where
        fs2.id = pp.feed_submission_id 
        and fs2.created_datetime > ${lastExecDateTime} and pp.base_currency ='BTC' 
        and fp.id = fs2.feed_provider_id 
        order by pp.pair_name, fs2.created_datetime desc, TO_NUMBER(pp.price, '999999999999999999999999999999999999999999999999999999999999999999999999999999');`

        if (recs.length == 0) {
            logger.error("No price data valid within "+validWithin);
            return {error: 'No data'};
        }
        logger.info("Retrieved "+recs.length+" price pairs");

        let median_batch = await prisma.median_batch.create({
            data: {
                id: crypto.randomUUID(),
                created_datetime: dateNow.toISOString(),
                batch_interval_sec: MEDIUM_PRICE_VALIDITY_WITHIN_SEC,
                cid: null,
                trx_ref: null
            }
        })
        if (!median_batch) {
            logger.error("Failed to create median_batch");
            return {error: 'Internal server error'};
        }

        const provider = new ethers.providers.JsonRpcProvider(BC_NODE_URL);
        const signer = new ethers.Wallet(BC_KEEPER_PRIVATE_KEY, provider);
        const keeperSigner = new ethers.Wallet(BC_KEEPER_PRIVATE_KEY, provider);
        
        const tabRegistryABI = [
            "function disableTab(bytes3) external",
            "function enableTab(bytes3) external"
        ];
        const tabRegistryContract = new ethers.Contract(
            BC_TAB_REGISTRY_CONTRACT,
            tabRegistryABI,
            signer
        );

        let priceMap = {};
        let uniqProv = {}; // within the median session(e.g. 5 minutes), if provider submits more than once, only pick latest submission
        providerSnapshotJson.ORACLE_FEEDS.push(JSON.parse(recs[0].json_content));
        let curr = recs[0].pair_name;
        for(let i=0; i < recs.length; i++) {
            if (curr == recs[i].pair_name) {
                if (uniqProv[recs[i].feed_provider_id]) // each currency price must be supplied by unique provider in current session window
                    continue;
                else
                    uniqProv[recs[i].feed_provider_id] = 1;
                
                if (priceMap[curr] == undefined) {
                    priceMap[curr] = [{
                        'price': BigNumber.from(recs[i].price),
                        'pairPriceId': recs[i].id
                    }];
                } else {
                    priceMap[curr].push({
                        'price': BigNumber.from(recs[i].price),
                        'pairPriceId': recs[i].id
                    });
                }
            } else { // sorted with pair_name, changed pair_name indicated start of new pair
                uniqProv = {};
                curr = recs[i].pair_name;
                let existedProvider = false;
                for(let f = 0; f < providerSnapshotJson.ORACLE_FEEDS.length; f++) {
                    if (providerSnapshotJson.ORACLE_FEEDS[f].data.provider == recs[i].pub_address)
                        existedProvider = true;
                }
                if (!existedProvider)
                    providerSnapshotJson.ORACLE_FEEDS.push(JSON.parse(recs[i].json_content));
                i = i -1; // stay in same row on next loop
            }
        }

        // loop all currencies: if feed count is less than MEDIUM_MIN_FEED_COUNT consecutively, disable corresponding Tab
        var sortedTabPriceMap = {};
        for(curr in priceMap) {
            let tabRec = await prisma.tab_registry.findFirst({
                where: {
                    tab_name :{
                        equals: curr
                    }
                }
            });
            if (!tabRec) {
                tabRec = await prisma.tab_registry.create({
                    data: {
                        id: crypto.randomUUID(),
                        tab_name: curr,
                        tab_code: ethers.utils.hexDataSlice(ethers.utils.formatBytes32String(curr), 0, 3),
                        is_clt_alt_del: false,
                        is_tab: false,
                        missing_count: 0,
                        revival_count: 0,
                        frozen: false
                    }
                });
            }

            if (priceMap[curr].length < MEDIUM_MIN_FEED_COUNT) { // e.g. pool size < 3, NOT acceptable
                let missedCount = tabRec.missing_count + 1;
                if (missedCount >= 3 && tabRec.frozen == false) { 
                    if (tabRec.is_tab)
                        await submitTrx_tab(curr, 'disable', keeperSigner, BC_TAB_REGISTRY_CONTRACT, tabRegistryContract);
                    tabRec = await prisma.tab_registry.update({
                        where: {
                            id: tabRec.id
                        },
                        data: {
                            missing_count: missedCount,
                            revival_count: 0,
                            frozen: true
                        }
                    });
                    logger.info("Tab Registry record is updated(frozen): "+tabRec.id);
                }
                else {
                    tabRec = await prisma.tab_registry.update({
                        where: {
                            id: tabRec.id
                        },
                        data: {
                            missing_count: missedCount,
                            revival_count: 0
                        }
                    });
                }
            } else { // pool size >= 3
                if (tabRec.frozen) {
                    if (tabRec.revival_count + 1 >= 3) {
                        if (tabRec.is_tab)
                            await submitTrx_tab(tabRec.tab_name, 'enable', keeperSigner, BC_TAB_REGISTRY_CONTRACT, tabRegistryContract);
                        tabRec = await prisma.tab_registry.update({
                            where: {
                                id: tabRec.id
                            },
                            data: {
                                missing_count: 0,
                                revival_count: 0,
                                frozen: false
                            }
                        });
                        logger.info("Frozen tab is revived, "+tabRec.id);
                    } else {
                        tabRec = await prisma.tab_registry.update({
                            where: {
                                id: tabRec.id
                            },
                            data: {
                                revival_count: tabRec.revival_count + 1
                            }
                        });
                    } 
                }        
            }// healthy provider count, poolSize > 3

            // sort price elements
            priceMap[curr].sort(
                function(a ,b) { // function(a, b) { return a-b }
                    let subResult = a['price'].sub(b['price']);
                    if (subResult.isZero())
                        return 0;
                    else if (subResult.gt(ZERO))
                        return 1;
                    else
                        return -1;
                }
            );

            let poolLength = priceMap[curr].length;
            let feedsMap = {};
            if (poolLength > MEDIUM_POOL_SIZE) {
                let strFeeds = '';
                for(let n = 0; n < poolLength; n++) 
                    strFeeds += ','+priceMap[curr][n].price.toString();
                feedsMap[curr] = strFeeds.substring(1);

                // reduce pool size to max. 9 elements
                for(let n = 0; n < poolLength - MEDIUM_POOL_SIZE; n++) {
                    let spliceIndex = getRandomInt(0, poolLength - n);
                    priceMap[curr].splice(spliceIndex, 1);
                }
            }

            let priceData = {};
            priceData.id = crypto.randomUUID();
            priceData.median_batch_id = median_batch.id;
            priceData.base_currency = 'BTC';
            priceData.pair_name = curr;
            priceData.median_value = getMedianValue(priceMap[curr]).toString();
            for(let n=0; n < priceMap[curr].length; n++) { // fill up DB slot fields, up to 9 fields
                priceData['slot_'+n] = priceMap[curr][n]['pairPriceId'];
            }
            priceData.active_slot = priceMap[curr].length;
            if (tabRec.is_tab) { // insert placeholder zero value to submit on-chain (fill up array size of 9)
                if (priceMap[curr].length < MEDIUM_POOL_SIZE) {
                    for(var n = 0; n < MEDIUM_POOL_SIZE - priceData.active_slot; n++) {
                        priceMap[curr].push({
                            'price': ZERO
                        });
                    }
                }
            }
            priceData.feeds = feedsMap[curr];
            let median_price = await prisma.median_price.create({
                data: priceData
            });

            if (tabRec.is_tab) {
                sortedTabPriceMap[curr] = {
                    length: priceData.active_slot >= 9? 9: priceData.active_slot,
                    sortedPool: getBigNumberList(priceMap[curr])
                }
            }
        } // each tab

        var strCID = await uploadIPFS(NFT_STORAGE_API_KEY, providerSnapshotJson);
        if (strCID)
            median_batch.cid = strCID;
        else {
            // Use dummy value if upload failed
            strCID = 'bafybeiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; // valid sample: bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi
            median_batch.cid = strCID;
        }

        let cidPart1 = ethers.utils.formatBytes32String(strCID.substring(0, 31));
        let cidPart2 = ethers.utils.formatBytes32String(strCID.substring(31));

        let oracleManagerContractABI = [
            "function updatePrice((bytes3,uint256,uint256,uint256[9])[10],(bytes32,bytes32))"
        ];
        let oracleManagerContract = new ethers.Contract(
            BC_PRICE_ORACLE_MANAGER_CONTRACT,
            oracleManagerContractABI,
            signer
        );
        
        var placeholderPrices = [];
        for(var n=0; n < MEDIUM_POOL_SIZE; n++)
            placeholderPrices.push(0);

        var totalRec = Object.keys(sortedTabPriceMap).length;
        logger.info("Preparing to submit "+totalRec+" tab prices.");
        var tabCount = 0;
        var tabPool = [];
        var trxRef = '';
        for(tabKey in sortedTabPriceMap) {
            if (tabCount > 0 && (tabCount % TAB_SUBMISSION_SIZE) == 0) { // reached 10 records, submit
                if (tabPool.length < TAB_SUBMISSION_SIZE) {
                    // if tab count is less than TAB_SUBMISSION_SIZE, append placeholders
                    for(var n=tabPool.length; n < TAB_SUBMISSION_SIZE; n++) {
                        tabPool.push([
                            ethers.utils.hexZeroPad('0x', 3),
                            0,
                            0,
                            placeholderPrices
                        ]);
                    }
                }
                var data = oracleManagerContract.interface.encodeFunctionData('updatePrice', [
                    tabPool,
                    [cidPart1, cidPart2]
                ]);
                var transaction = {
                    to: BC_PRICE_ORACLE_MANAGER_CONTRACT,
                    data: data,
                    gasLimit: 10000000 // 10m
                };
                const tx = await signer.sendTransaction(transaction);
                let receipt = await tx.wait();
                logger.info("Submitted "+tabCount+" records. TX: "+receipt.transactionHash);
                trxRef += ',' + receipt.transactionHash;

                tabPool = [];
            }
            tabPool.push([
                ethers.utils.hexDataSlice(ethers.utils.formatBytes32String(tabKey), 0, 3),
                now,
                sortedTabPriceMap[tabKey].length,
                sortedTabPriceMap[tabKey].sortedPool
            ]);
            tabCount++;
        }

        if (tabPool.length > 0) {
            if (tabPool.length < TAB_SUBMISSION_SIZE) {
                for(var n=tabPool.length; n < TAB_SUBMISSION_SIZE; n++) {
                    tabPool.push([
                        ethers.utils.hexZeroPad('0x', 3),
                        0,
                        0,
                        placeholderPrices
                    ]);
                }
            }
            var data = oracleManagerContract.interface.encodeFunctionData('updatePrice', [
                tabPool,
                [cidPart1, cidPart2]
            ]);
            var transaction = {
                to: BC_PRICE_ORACLE_MANAGER_CONTRACT,
                data: data,
                gasLimit: 10000000 // 10m
            };
            const tx = await signer.sendTransaction(transaction);
            let receipt = await tx.wait();
            logger.info("Submitted last batch of "+tabPool.length+" tab records. TX: "+receipt.transactionHash);
            trxRef += ','+receipt.transactionHash;
        }
        if (trxRef)
            trxRef = trxRef.substring(1); // skip leading comma

        let upd_median_batch = await prisma.median_batch.update({
            where: {
                id: median_batch.id
            },
            data: {
                cid: median_batch.cid,
                trx_ref: trxRef
            }
        });
        return {'median_batch': upd_median_batch.id};
    
    } catch (error) {
        logger.error(error);
        return {error: 'Internal server error'};
    }
};

exports.medianPrice = {
    getLiveMedianPrices,
    groupAndSendMedianPrices
}