const logger = require('./logger');
const { prisma } = require('./prisma');
const ethers = require('ethers');
const crypto = require('crypto');
const axios = require('axios');
const { WRAPPED_BTC_RESERVE_SYMBOL } = require('./config');

const MEDIUM_PRICE_VALIDITY_WITHIN_SEC = (60 * 5); // price is valid only if it is sent within 5 minutes
const MEDIUM_POOL_SIZE = 9;
const MEDIUM_MIN_FEED_COUNT = 3;
const ZERO = 0n;
const PRECISION = BigInt('10000000000000000000000000000');

function getRandomInt(min, max) {
    min = Math.ceil(min);
    max = Math.floor(max);
    return Math.floor(Math.random() * (max - min) + min); // The maximum is exclusive and the minimum is inclusive
}

function getWrappedBTCReserves() {
    return WRAPPED_BTC_RESERVE_SYMBOL.split(',');
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
            let sumOf2MidItems = values[midIndex - 1].price + values[midIndex].price;
            return sumOf2MidItems / 2n;
        } else {
            return values[midIndex].price;
        }
    }
}

// To calc. Wrapped BTC Token to Fiat rate
function getAdjustedWrappedBTCTokenPrice(wrappedToUsd, btcToUsd, btcToFiat) {
    if (btcToUsd == btcToFiat)
        return wrappedToUsd;
    return (BigInt(wrappedToUsd) * PRECISION / BigInt(btcToUsd) * BigInt(btcToFiat) / PRECISION).toString();
}

async function submitTrx_tab(strTab, strMode, signer, tabRegistryContractAddr, tabRegistryContract) {
    let data;
    let tab = ethers.dataSlice(ethers.toUtf8Bytes(strTab), 0, 3);
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
    logger.info(strMode + " tab trx hash: " + receipt.hash);
}

// refer https://nft.storage/api-docs/
async function uploadIPFS(NFT_STORAGE_API_KEY, jsonContent) {
    if (jsonContent.ORACLE_FEEDS.length == 0) {
        logger.error("Skipped IPFS upload: Empty ORACLE_FEEDS content.");
        return '';
    }
    return '';

    // var config = {
    //     method: 'post',
    //     maxBodyLength: Infinity,
    //     url: 'https://api.nft.storage/upload',
    //     headers: {
    //         'Content-Type': 'application/json',
    //         'Authorization': `Bearer ${NFT_STORAGE_API_KEY}`
    //     },
    //     data: JSON.stringify(jsonContent)
    // };
    // var cid = '';
    // logger.info('Ready to upload...');
    // await axios.request(config)
    //     .then((response) => {
    //         var res = response.data;
    //         cid = res.value.cid;
    //         console.log(res);
    //         logger.info('Uploaded is completed. CIDv1: ' + cid);
    //     })
    //     .catch((error) => {
    //         logger.error(error);
    //     });
    // return cid;
}

async function getHistoricalPrices(curr, maxCount, reserveSymbol) {
    try {
        curr = curr.substring(0,3).toUpperCase();
        maxCount = parseInt(maxCount);
        if (!Number.isInteger(maxCount))
            maxCount = 10;
        if (maxCount > 50)
            maxCount = 50;

        const medianPrices = await prisma.median_price.findMany({
            take: maxCount,
            where: {
                base_currency: {
                    equals: 'BTC'
                },
                pair_name: {
                    equals: curr
                }
            },
            orderBy: {
                median_batch: {
                    created_datetime: 'desc'
                }
            },
            include: {
                median_batch: true
            }
        });
        if (!medianPrices) {
            return {
                timestamp: new Date().getTime(),
                count: 0,
                records: []
            }
        }
        let history = {};
        history.timestamp = new Date().getTime();
        history.count = medianPrices.length;
        let records = [];
        for(let i=0; i < medianPrices.length; i++) {
            let r = medianPrices[i];
            let strRate = '0';

            if (curr.indexOf('USD') > -1 && reserveSymbol.indexOf('USD') > -1)
                strRate = '1000000000000000000';
            else if (reserveSymbol == 'BTC')
                strRate = r.median_value;
            else {
                let btcusdRec = await prisma.median_price.findFirst({
                    where: {
                        base_currency: {
                            equals:'BTC'
                        },
                        pair_name: {
                            equals: 'USD'
                        },
                        median_batch_id: {
                            equals: r.median_batch_id
                        }
                    }
                });
                let wrappedBTCRec = await prisma.median_price.findFirst({
                    where: {
                        base_currency: {
                            equals: reserveSymbol
                        },
                        pair_name: {
                            equals: 'USD'
                        },
                        median_batch_id: {
                            equals: r.median_batch_id
                        }
                    }
                });
                if (btcusdRec && wrappedBTCRec) {
                    strRate = getAdjustedWrappedBTCTokenPrice(
                        wrappedBTCRec.median_value, 
                        btcusdRec.median_value, 
                        r.median_value
                    );
                } else {
                    logger.error("No BTC/USD or Wrapped BTC Token rate. Median batch id: "+r.median_batch_id);
                    strRate = r.median_value;
                }
            }

            records.push({
                time: r.median_batch.created_datetime.getTime(),
                rate: strRate,
                provider_count: r.active_slot,
                status: r.tab_status,
                refresh: r.refresh_median,
                movement_delta: r.movement_delta,
                overwritten_median: r.overwritten_median
            });
        }
        history.records = records;
        return history;
    } catch(error) {
        logger.error(error);
        return {error: 'Internal server error'};
    }
}

async function getLiveMedianPrices(bRequiredDetails, bTabOnly, filterCurr, configMap) {
    try {
        let dateNow = new Date();
        let now = BigInt(Math.floor(dateNow.getTime() / 1000));
        let iDateSince = Number(now - configMap.inactivePeriod - BigInt((5 * 60)));
        let selectCondition = {
            last_updated: {
                gte: new Date(iDateSince)
            }
        };
        let btcReserves = getWrappedBTCReserves();
        if (filterCurr) {
            filterCurr = filterCurr.substring(0,3).toUpperCase();
            let filterList = [];
            if (filterCurr == 'USD')
                filterList.push('USD');
            else {
                filterList.push('USD');
                filterList.push(filterCurr);
            }

            for(let i=0; i < btcReserves.length; i++)
                filterList.push(btcReserves[i]);

            selectCondition.pair_name = {
                in: filterList
            }
        }
        const rawActiveMedianList = await prisma.active_median.findMany({
            where: selectCondition,
            orderBy: [
                {
                    pair_name: 'asc'
                },
                {
                    last_updated: 'desc'
                }
            ]
        });
        if (rawActiveMedianList.length == 0)
            return { error: 'No data' };
        
        // loop rawActiveMedianList to keep unique tab currency only
        let activeMedians = {}; 
        activeMedians[rawActiveMedianList[0].pair_name] = rawActiveMedianList[0];
        for(let i = 0; i < rawActiveMedianList.length; i++) {
            if (activeMedians[rawActiveMedianList[i].pair_name])
                continue;
            else
                activeMedians[rawActiveMedianList[i].pair_name] = rawActiveMedianList[i];
        }

        let batch = {};
        batch.timestamp = dateNow.getTime();
        let quotes = {};
        let wrappedBTCTokens = {};
        let pair = '';
        
        for(let key in activeMedians) {
            let activeMedian = activeMedians[key];
            let curr = activeMedian.pair_name;
            let medianPrice = await prisma.median_price.findFirst({
                where: {
                    id: {
                        equals: activeMedian.median_price_id
                    }
                },
                include:{
                    median_batch: true
                }
            });
            if (btcReserves.indexOf(curr) > -1) {
                wrappedBTCTokens[curr] = {
                    'median': medianPrice.median_value,
                    'last_updated': activeMedian.last_updated.getTime()
                }
            } else {
                pair = medianPrice.base_currency + curr;
                let tabRec = await prisma.tab_registry.findFirst({
                    where: {
                        tab_name: {
                            equals: curr
                        }
                    }
                });
                if (bTabOnly) { // non-tab result is excluded
                    if (tabRec) {
                        if (tabRec.is_tab == false)
                            continue;
                    } else
                        continue;
                }
                if (!tabRec)
                    continue;
                quotes[pair] = {
                    tab: {
                        tab_code: tabRec.tab_code,
                        tab_name: tabRec.tab_name,
                        currency_name: tabRec.curr_name,
                        is_clt_alt_del: tabRec.is_clt_alt_del,
                        is_tab: tabRec.is_tab,
                        missing_count: tabRec.missing_count,
                        revival_count: tabRec.revival_count,
                        frozen: tabRec.frozen,
                        risk_penalty_per_frame: configMap[tabRec.tab_name]? Number(configMap[tabRec.tab_name].riskPenaltyPerFrame): 0,
                        process_fee_rate: configMap[tabRec.tab_name]? Number(configMap[tabRec.tab_name].processFeeRate): 0,
                        min_reserve_ratio: configMap[tabRec.tab_name]? Number(configMap[tabRec.tab_name].minReserveRatio): 0,
                        liquidation_ratio: configMap[tabRec.tab_name]? Number(configMap[tabRec.tab_name].liquidationRatio): 0
                    },
                    median: medianPrice.median_value,
                    last_updated: activeMedian.last_updated.getTime(),
                    cid: medianPrice.median_batch.cid
                }
                if (bRequiredDetails) {
                    let detailList = [];
                    for (let n = 0; n < medianPrice.active_slot; n++) {
                        let slotName = 'slot_' + n;
                        let pricePairId = medianPrice[slotName];
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
        }
        batch.data = {
            'popular_tabs': configMap.popularTabs,
            'wrapped_BTC_tokens': wrappedBTCTokens,
            'quotes': quotes
        };
        return batch;
    } catch (error) {
        logger.error(error);
        return { error: 'Internal server error' };
    }
};

async function getPeggedRate(strTab) {
    let peggedTab = await prisma.pegged_tab_registry.findUnique({
        where: {
            pegged_tab: strTab
        }
    });
    if (peggedTab) {
        const activeMedian = await prisma.active_median.findFirst({
            where: {
                pair_name: {
                    equals: peggedTab.peg_to_tab
                }
            },
            orderBy: {
                last_updated: 'desc'
            },
            include: {
                median_price: true
            }
        });
        if (activeMedian) {
            return {
                median: activeMedian,
                rate: BigInt(activeMedian.median_price.median_value) * BigInt(peggedTab.peg_to_ratio) / BigInt("100"),
                peggedTab: peggedTab
            };
        }
    }
    return {rate: 0};
}

// key: existing tab(peg_to_tab)
// value: list of pegged_tab_registry records that is pegging to existing tab's rate
async function getPeggedTabs() {
    let recs = await prisma.pegged_tab_registry.findMany({
        orderBy: {
            peg_to_tab: 'asc'
        }
    });
    let tabs = {};
    if (recs) {
        for(let n=0; n < recs.length; n++) {
            if (tabs[recs[n].peg_to_tab])
                tabs[recs[n].peg_to_tab].push(recs[n]);
            else    
                tabs[recs[n].peg_to_tab] = [recs[n]];
        }
    }
    return tabs;
}

async function signMedianPrice(userAddr, tab, price, timestamp, rpcUrl, priKey, priceOracleAddr) {
    const provider = new ethers.JsonRpcProvider(rpcUrl, undefined, {staticNetwork: true});
    const chainId = (await provider.getNetwork()).chainId;
    const signer = new ethers.Wallet(priKey, provider); // PriceOracle.FEEDER_ROLE holder
    const priceOracleABI = [
        "function nonces(address) external view returns (uint256)"
    ];
    const priceOracleContract = new ethers.Contract(
        priceOracleAddr,
        priceOracleABI,
        signer
    );
    const nonces = await priceOracleContract.nonces(userAddr);
    const domain = {
        name: "PriceOracle",
        version: "1",
        chainId: chainId,
        verifyingContract: priceOracleAddr
    };
    const types = {
        UpdatePriceData: [
            {
                name: "owner",  // owner of tab oracle price update role
                type: "address"
            },
            {
                name: "updater", // user who spend gas to update price
                type: "address"
            },
            {
                name: "tab",
                type: "bytes3"
            },
            {
                name: "price",
                type: "uint256"
            },
            {
                name: "timestamp",
                type: "uint256"
            },
            {
                name: "nonce",
                type: "uint256"
            }
        ],
    };
    const values = {
        owner: signer.address,
        updater: userAddr,
        tab: tab,
        price: price,
        timestamp: timestamp,
        nonce: nonces.toString()
    };
    const signature = await signer.signTypedData(domain, types, values);
    const sig = ethers.Signature.from(signature);
    // const recovered = ethers.verifyTypedData(domain, types, values, sig);
    // console.log("recovered: "+recovered);
    
    return {
        owner: signer.address,
        updater: userAddr,
        tab: tab,
        price: price,
        timestamp: timestamp,
        nonce: nonces.toString(),
        signature: signature,
        v: sig.v,
        r: sig.r,
        s: sig.s
    }
}

async function getSignedMedianPrice(
    BC_NODE_URL, 
    BC_PRICE_ORACLE_SIGNER_PRIVATE_KEY, 
    BC_PRICE_ORACLE_CONTRACT, 
    userAddr, 
    curr, 
    reserveSymbol
) {
    try {
        curr = curr.substring(0, 3).toUpperCase();
        if (!reserveSymbol)
            reserveSymbol = 'CBBTC';
        const activeMedian = await prisma.active_median.findFirst({
            where: {
                pair_name: {
                    equals: curr
                }
            },
            orderBy: {
                last_updated: 'desc'
            },
            include: {
                median_price: true
            }
        });

        let peggedRateRec;
        if (!activeMedian) {
            // Calculate pegged rate if it is pegged tab
            peggedRateRec = getPeggedRate(curr);
            if (peggedRateRec.rate == 0)
                return { error: 'No data' };
            else
                activeMedian = peggedRateRec.median;
        }
        
        // Retrieve Wrapped BTC Token rate
        const wrappedReserve = await prisma.active_median.findFirst({
            where: {
                pair_name: {
                    equals: reserveSymbol
                }
            },
            orderBy: {
                last_updated: 'desc'
            },
            include: {
                median_price: true
            }
        });
        if (!wrappedReserve)
            return { error: 'No wrapped BTC reserve token: '+reserveSymbol };
        let btcUsdRate = 0;
        if (curr == 'USD')
            btcUsdRate = activeMedian.median_price.median_value;
        else {
            const btcusd = await prisma.active_median.findFirst({
                where: {
                    pair_name: {
                        equals: 'USD'
                    }
                },
                orderBy: {
                    last_updated: 'desc'
                },
                include: {
                    median_price: true
                }
            });
            if (!btcusd)
                return { error: 'No BTC/USD rate' };
            btcUsdRate = btcusd.median_price.median_value;
        }

        let batch = {};
        batch.timestamp = activeMedian.last_updated.getTime();
        const wrappedBTCToTab = getAdjustedWrappedBTCTokenPrice(
            wrappedReserve.median_price.median_value, 
            btcUsdRate, 
            peggedRateRec? peggedRateRec.rate: activeMedian.median_price.median_value
        );
        const price_signature = await signMedianPrice(
            userAddr,
            ethers.dataSlice(ethers.toUtf8Bytes(curr), 0, 3),
            wrappedBTCToTab,
            batch.timestamp,
            BC_NODE_URL,
            BC_PRICE_ORACLE_SIGNER_PRIVATE_KEY,
            BC_PRICE_ORACLE_CONTRACT
        );
        let quotes = {};
        let pairName = peggedRateRec? ('BTC'+curr): ('BTC'+activeMedian.pair_name);
        quotes[pairName] = {
            'reserveSymbol': reserveSymbol,
            'median': wrappedBTCToTab,
            'btcToTab': peggedRateRec? peggedRateRec.rate: activeMedian.median_price.median_value,
            'signed': price_signature
        };
        batch.data = {
            'quotes': quotes
        };
        return batch;
    } catch (error) {
        logger.error(error);
        return { error: 'Internal server error' };
    }
}

function calcMovementDelta(_old, _new) {
    let oldPrice = BigInt(_old);
    let newPrice = BigInt(_new);
    let delta = (((newPrice - oldPrice) * BigInt(1000000000000000000)) / oldPrice) * BigInt(100);
    if (delta < 0)
        return delta * BigInt(-1);
    else
        return delta;
}

async function groupMedianPrices(
    NODE_ENV,
    BC_NODE_URL, 
    BC_TAB_FREEZER_PRIVATE_KEY, 
    BC_TAB_REGISTRY_CONTRACT, 
    NFT_STORAGE_API_KEY,
    configMap
) {
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
        logger.info("Retrieving feed submission older than " + lastExecDateTime.toISOString());

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
    order by 
        pp.pair_name, fs2.created_datetime desc, TO_NUMBER(pp.price, '999999999999999999999999999999999999999999999999999999999999999999999999999999');`

        if (recs.length == 0) {
            logger.error("No price data valid within " + validWithin);
            return { error: 'No data' };
        }
        logger.info("Retrieved " + recs.length + " price pairs");

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
            return { error: 'Internal server error' };
        }

        const provider = new ethers.JsonRpcProvider(BC_NODE_URL, undefined, {staticNetwork: true});
        const freezerSigner = new ethers.Wallet(BC_TAB_FREEZER_PRIVATE_KEY, provider);

        const tabRegistryABI = [
            "function disableTab(bytes3) external",
            "function enableTab(bytes3) external"
        ];
        const tabRegistryContract = new ethers.Contract(
            BC_TAB_REGISTRY_CONTRACT,
            tabRegistryABI,
            freezerSigner
        );

        let priceMap = {};
        let uniqProv = {}; // within the median session(e.g. 5 minutes), if provider submits more than once, pick latest submission
        providerSnapshotJson.ORACLE_FEEDS.push(JSON.parse(recs[0].json_content));
        let curr = recs[0].pair_name;
        for (let i = 0; i < recs.length; i++) {
            if (curr == recs[i].pair_name) {
                if (uniqProv[recs[i].feed_provider_id]) // each currency price must be supplied by unique provider in current session window
                    continue;
                else
                    uniqProv[recs[i].feed_provider_id] = 1;

                if (priceMap[curr] == undefined) {
                    priceMap[curr] = [{
                        'price': BigInt(recs[i].price),
                        'pairPriceId': recs[i].id
                    }];
                } else {
                    priceMap[curr].push({
                        'price': BigInt(recs[i].price),
                        'pairPriceId': recs[i].id
                    });
                }
            } else { // sorted with pair_name, changed pair_name indicated start of new pair
                uniqProv = {};
                curr = recs[i].pair_name;
                let existedProvider = false;
                for (let f = 0; f < providerSnapshotJson.ORACLE_FEEDS.length; f++) {
                    if (providerSnapshotJson.ORACLE_FEEDS[f].data.provider == recs[i].pub_address)
                        existedProvider = true;
                }
                if (!existedProvider)
                    providerSnapshotJson.ORACLE_FEEDS.push(JSON.parse(recs[i].json_content));
                i = i - 1; // stay in same row on next loop
            }
        }

        // Wrapped BTC Tokens
        let wrappedRecs = await prisma.$queryRaw`select
        fs2.feed_provider_id,
        wb.id,
        wb.symbol,
        wb.price 
    from
        feed_submission fs2,
        wrapped_btc wb
    where
        fs2.id = wb.feed_submission_id 
        and fs2.created_datetime > ${lastExecDateTime} and wb.dest_currency ='USD' 
    order by 
        wb.symbol, fs2.created_datetime desc, TO_NUMBER(wb.price, '999999999999999999999999999999999999999999999999999999999999999999999999999999');`
        
        uniqProv = {};
        curr = wrappedRecs[0].symbol;
        logger.info("Preparing to loop "+wrappedRecs.length+" wrapped BTC records.");
        for (let i = 0; i < wrappedRecs.length; i++) {
            if (curr == wrappedRecs[i].symbol) {
                if (uniqProv[wrappedRecs[i].feed_provider_id]) // each currency price must be supplied by unique provider in current session window
                    continue;
                else
                    uniqProv[wrappedRecs[i].feed_provider_id] = 1;

                if (priceMap[curr] == undefined) {
                    priceMap[curr] = [{
                        'price': BigInt(wrappedRecs[i].price),
                        'pairPriceId': wrappedRecs[i].id
                    }];
                } else {
                    priceMap[curr].push({
                        'price': BigInt(wrappedRecs[i].price),
                        'pairPriceId': wrappedRecs[i].id
                    });
                }
            } else {
                uniqProv = {};
                curr = wrappedRecs[i].symbol;
                i = i - 1; // stay in same row on next loop
            }
        }

        // loop all currencies: if feed count is less than MEDIUM_MIN_FEED_COUNT consecutively, disable corresponding Tab
        let tabStatus = 'A'; // A:Active, R:Recovering, F:Frozen, M:Missed
        let c = 0;
        let peggedTabs = await getPeggedTabs();
        
        for (curr in priceMap) {
            let tabRec = await prisma.tab_registry.findFirst({
                where: {
                    tab_name: {
                        equals: curr
                    }
                }
            });
            if (!tabRec && curr.length == 3) {
                tabRec = await prisma.tab_registry.create({
                    data: {
                        id: crypto.randomUUID(),
                        tab_name: curr,
                        tab_code: ethers.dataSlice(ethers.toUtf8Bytes(curr), 0, 3),
                        is_clt_alt_del: false,
                        is_tab: false,
                        missing_count: 0,
                        revival_count: 0,
                        frozen: false
                    }
                });
                logger.info("created new tab_registry "+tabRec.id+" curr: "+curr);
            }
          
            if (curr.length == 3) {
                if (priceMap[curr].length < MEDIUM_MIN_FEED_COUNT) { // e.g. pool size < 3, NOT acceptable
                    let missedCount = tabRec.missing_count + 1;
                    if (missedCount >= 3 && tabRec.frozen == false) {
                        if (tabRec.is_tab)
                            await submitTrx_tab(curr, 'disable', freezerSigner, BC_TAB_REGISTRY_CONTRACT, tabRegistryContract);
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
                        tabStatus = 'F';
                        logger.info("Tab Registry record is updated(frozen): " + tabRec.id);
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
                        tabStatus = 'M';
                    }
                } else { // pool size >= 3
                    if (tabRec.frozen) {
                        if ((tabRec.revival_count + 1) >= 3) {
                            if (tabRec.is_tab)
                                await submitTrx_tab(tabRec.tab_name, 'enable', freezerSigner, BC_TAB_REGISTRY_CONTRACT, tabRegistryContract);
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
                            tabStatus = 'A';
                            logger.info("Frozen tab is revived, " + tabRec.id);
                        } else {
                            tabRec = await prisma.tab_registry.update({
                                where: {
                                    id: tabRec.id
                                },
                                data: {
                                    revival_count: tabRec.revival_count + 1
                                }
                            });
                            tabStatus = 'R';
                        }
                    } else {
                        tabRec = await prisma.tab_registry.update({
                            where: {
                                id: tabRec.id
                            },
                            data: {
                                missing_count: 0,
                                revival_count: 0
                            }
                        });
                        tabStatus = 'A';
                    }
                }// healthy provider count, poolSize > 3
            }

            // sort price elements
            priceMap[curr].sort(
                function (a, b) { // function(a, b) { return a-b }
                    let subResult = a['price'] - b['price'];
                    if (subResult == 0)
                        return 0;
                    else if (subResult > 0)
                        return 1;
                    else
                        return -1;
                }
            );

            let poolLength = priceMap[curr].length;
            let feedsMap = {};
            if (poolLength > MEDIUM_POOL_SIZE) {
                let strFeeds = '';
                for (let n = 0; n < poolLength; n++)
                    strFeeds += ',' + priceMap[curr][n].price.toString();
                feedsMap[curr] = strFeeds.substring(1);

                // reduce pool size to max. 9 elements
                for (let n = 0; n < poolLength - MEDIUM_POOL_SIZE; n++) {
                    let spliceIndex = getRandomInt(0, poolLength - n);
                    priceMap[curr].splice(spliceIndex, 1);
                }
            }

            let priceData = {};
            priceData.id = crypto.randomUUID();
            priceData.median_batch_id = median_batch.id;
            if (curr.length == 3) {
                priceData.base_currency = 'BTC';
                priceData.pair_name = curr;
            } else { // wrapped BTC token
                priceData.base_currency = curr;
                priceData.pair_name = 'USD';
            }
            priceData.median_value = getMedianValue(priceMap[curr]).toString();
            for (let n = 0; n < priceMap[curr].length; n++) { // fill up DB slot fields, up to 9 fields
                priceData['slot_' + n] = priceMap[curr][n]['pairPriceId'];
            }
            priceData.active_slot = priceMap[curr].length;
            priceData.tab_status = tabStatus;
            if (tabRec && tabRec.is_tab) { // insert placeholder zero value to submit on-chain (fill up array size of 9)
                if (priceMap[curr].length < MEDIUM_POOL_SIZE) {
                    for (var n = 0; n < MEDIUM_POOL_SIZE - priceData.active_slot; n++) {
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

            // there is/are pegging tab(s) relied on this tab's rate
            if (peggedTabs[curr]) { 
                let pgTabList = peggedTabs[curr];
                for(let p=0; p < pgTabList.length; p++) {
                    priceData.id = crypto.randomUUID();
                    priceData.pair_name = pgTabList[p].pegged_tab;
                    priceData.median_value = (BigInt(priceData.median_value) * BigInt(pgTabList[p].peg_to_ratio) / BigInt('100')).toString();
                    let mp = await prisma.median_price.create({
                        data: priceData
                    });
                    peggedTabs['MP_'+pgTabList[p].pegged_tab] = mp;
                }
            }

            // update new median if delta with existing median value exceeded 0.5%
            // median value will be updated every 1 hour regardless of delta
            var activeMedian = await prisma.active_median.findFirst({
                where: {
                    pair_name: {
                        equals: curr
                    }
                },
                orderBy: {
                    last_updated: 'desc'
                },
                include: {
                    median_price: true
                }
            });
            var bRefreshMedian = false;
            var movementDelta = 0;
            var overwrittenMedian = '0';
            if (activeMedian) {
                movementDelta = calcMovementDelta(activeMedian.median_price.median_value, priceData.median_value);
                overwrittenMedian = activeMedian.median_price.median_value;

                // exceeded inactive period (1 hour), update active median regardless of price movement delta
                if (Math.floor((median_batch.created_datetime.getTime() - activeMedian.last_updated.getTime()) / 1000) >=  configMap.inactivePeriod) {
                    bRefreshMedian = true;
                    activeMedian = await prisma.active_median.create({
                        data: {
                            id: crypto.randomUUID(),
                            last_updated: median_batch.created_datetime,
                            median_price_id: median_price.id,
                            pair_name: curr
                        }
                    });
                    if (peggedTabs[curr]) { 
                        let pgTabList = peggedTabs[curr];
                        for(let p=0; p < pgTabList.length; p++) {
                            await prisma.active_median.create({
                                data: {
                                    id: crypto.randomUUID(),
                                    last_updated: median_batch.created_datetime,
                                    median_price_id: peggedTabs['MP_'+pgTabList[p].pegged_tab].id,
                                    pair_name: pgTabList[p].pegged_tab
                                }
                            });
                        }
                    }
                } else {
                    // price movement delta > 0.5%
                    if (movementDelta > ( ethers.parseEther(configMap.movementDelta.toString()) / 10000n)) {
                        bRefreshMedian = true;
                        activeMedian = await prisma.active_median.create({
                            data: {
                                id: crypto.randomUUID(),
                                last_updated: median_batch.created_datetime,
                                median_price_id: median_price.id,
                                pair_name: curr
                            }
                        });
                        if (peggedTabs[curr]) { 
                            let pgTabList = peggedTabs[curr];
                            for(let p=0; p < pgTabList.length; p++) {
                                await prisma.active_median.create({
                                    data: {
                                        id: crypto.randomUUID(),
                                        last_updated: median_batch.created_datetime,
                                        median_price_id: peggedTabs['MP_'+pgTabList[p].pegged_tab].id,
                                        pair_name: pgTabList[p].pegged_tab
                                    }
                                });
                            }
                        }
                    } 
                }
            } else {
                bRefreshMedian = true;
                activeMedian = await prisma.active_median.create({
                    data: {
                        id: crypto.randomUUID(),
                        last_updated: median_batch.created_datetime,
                        median_price_id: median_price.id,
                        pair_name: curr
                    }
                });
                if (peggedTabs[curr]) { 
                    let pgTabList = peggedTabs[curr];
                    for(let p=0; p < pgTabList.length; p++) {
                        await prisma.active_median.create({
                            data: {
                                id: crypto.randomUUID(),
                                last_updated: median_batch.created_datetime,
                                median_price_id: peggedTabs['MP_'+pgTabList[p].pegged_tab].id,
                                pair_name: pgTabList[p].pegged_tab
                            }
                        });
                    }
                }
            }

            await prisma.median_price.update({
                where: {
                    id: median_price.id
                },
                data: {
                    refresh_median: bRefreshMedian,
                    movement_delta: movementDelta.toString(),
	                overwritten_median: overwrittenMedian
                }
            });
            if (peggedTabs[curr]) { 
                let pgTabList = peggedTabs[curr];
                for(let p=0; p < pgTabList.length; p++) {
                    await prisma.median_price.update({
                        where: {
                            id: peggedTabs['MP_'+pgTabList[p].pegged_tab].id
                        },
                        data: {
                            refresh_median: bRefreshMedian,
                            movement_delta: '0',
                            overwritten_median: '0'
                        }
                    });
                }
            }
            c++;

        } // each tab
        logger.info("Processed "+c+" tab median records");

        if (NODE_ENV == 'local') {
            median_batch.cid = 'LOCAL_SKIP_UPLOAD';
        } else {
            var strCID = await uploadIPFS(NFT_STORAGE_API_KEY, providerSnapshotJson);
            if (strCID) {
                median_batch.cid = strCID;
                logger.info("CID: "+strCID);
            } else {
                // Use dummy value if upload failed
                strCID = ''; // valid sample: bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi
                median_batch.cid = strCID;
            }
        }

        await prisma.median_batch.update({
            where: {
                id: median_batch.id
            },
            data: {
                cid: median_batch.cid,
                trx_ref: null   // on-chain upload is cancelled
            }
        });

        return { 'median_batch': median_batch.id };

    } catch (error) {
        logger.error(error);
        return { error: 'Internal server error' };
    }
};

exports.medianPrice = {
    getHistoricalPrices,
    getLiveMedianPrices,
    getSignedMedianPrice,
    groupMedianPrices
}