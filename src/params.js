const logger = require('./logger');
const {prisma} = require('./prisma');
const ethers = require('ethers');
const crypto = require('crypto');
const { default: axios } = require('axios');

var provMap = {};
var tabMap = {};

function bytes3ToString(arrBytes3) {
    var arrString = [];
    for (let i = 0; i < arrBytes3.length; i++) {
        if (arrBytes3[i] != 0)
            arrString.push(ethers.utils.toUtf8String(arrBytes3[i]));
    }
    return arrString;
}

async function cacheParamsJob (BC_NODE_URL, BC_PRICE_ORACLE_MANAGER_CONTRACT, BC_TAB_REGISTRY_CONTRACT) {
    logger.info("cacheParamsJob is started...");
    try {
        const provider = new ethers.providers.JsonRpcProvider(BC_NODE_URL);

        // read oracle provider related data
        let oracleManagerContractABI = [
            "function providerCount() external view returns(uint256)",
            "function providerList(uint256) external view returns(address)",
            "function providers(address) external view returns(uint256,uint256,uint256,uint256,uint256,bool)",
            "function providerInfo(address) external view returns(uint256,address,uint256,uint256,uint256,bytes32)"
        ];
        let oracleManagerContract = new ethers.Contract(
            BC_PRICE_ORACLE_MANAGER_CONTRACT,
            oracleManagerContractABI,
            provider
        );

        let providerCount = await oracleManagerContract.providerCount();
        for (let n = 0; n < providerCount; n++) {
            let provAddr = await oracleManagerContract.providerList(n);
            // logger.info("Provider " + n + ": "+ provAddr);

            if (provAddr) {
                let dateNow = new Date();
                let now = Math.floor(dateNow.getTime() / 1000);

                let dbProvider = provMap[provAddr]? provMap[provAddr]: {
                    updated_datetime: dateNow.toISOString(),
                    pub_address: provAddr
                };
                delete dbProvider['auth'];
                // struct OracleProvider {
                //     uint256 index;
                //     uint256 activatedSinceBlockId;
                //     uint256 activatedTimestamp;
                //     uint256 disabledOnBlockId;
                //     uint256 disabledTimestamp;
                //     bool paused;
                // }
                let prov = await oracleManagerContract.providers(provAddr);
                dbProvider.index = prov[0].toString();
                dbProvider.activated_since_block = prov[1].toString();
                dbProvider.activated_timestamp = prov[2].toString();
                dbProvider.disabled_since_block = prov[3].toString();
                dbProvider.disabled_timestamp = prov[4].toString();
                dbProvider.paused = prov[5];

                // disabledOnBlockId == 0 && disabledTimestamp == 0 && !paused && current >= activatedTimestamp
                if (prov[3].isZero() && prov[4].isZero() && !dbProvider.paused && now >= Number(dbProvider.activated_timestamp)) {
                    // struct Info {
                    //     uint256 paymentTermInBlockCount;
                    //     address paymentTokenAddress;
                    //     uint256 paymentAmt;
                    //     uint256 blockCountPerFeed;
                    //     uint256 feedSize;
                    //     bytes32 whitelistedIPAddr;
                    // }
                    let provInfo = await oracleManagerContract.providerInfo(provAddr);
                    dbProvider.payment_term_block_count = provInfo[0].toString();
                    dbProvider.payment_token_address = provInfo[1];
                    dbProvider.payment_amount = provInfo[2].toString();
                    dbProvider.block_count_per_feed = provInfo[3].toString();
                    dbProvider.feed_size = provInfo[4].toString();
                    dbProvider.whitelisted_ip = provInfo[5] ? ethers.utils.parseBytes32String(provInfo[5]) : ''
                }

                const dbRec = await prisma.feed_provider.findUnique({
                    where: {
                        pub_address: provAddr
                    }
                });
                if (dbRec) {
                    const result = await prisma.feed_provider.updateMany({
                        where: {
                            pub_address: provAddr
                        },
                        data: dbProvider
                    });
                    dbProvider.id = dbRec.id;
                    dbProvider.created_datetime = dbRec.created_datetime;
                    // logger.info("Update provider: "+ dbProvider.pub_address);
                } else {
                    dbProvider.id = crypto.randomUUID();
                    dbProvider.created_datetime = dbProvider.updated_datetime;
                    const result = await prisma.feed_provider.create({
                        data: dbProvider
                    });
                    // logger.info("New provider: "+ dbProvider.pub_address);
                }
                provMap[provAddr] = dbProvider;
            }
        }

        // read TAB data
        let tabRegistryContractABI = [
            "function activatedTabCount() external view returns(uint256)",
            "function tabList(uint256) external view returns(bytes3)",
            "function frozenTabs(bytes3) external view returns(bool)",
            "function getCtrlAltDelTabList() external view returns (bytes3[] memory ctrlAltDelTabList)"
        ];

        let tabRegistryContract = new ethers.Contract(
            BC_TAB_REGISTRY_CONTRACT,
            tabRegistryContractABI,
            provider
        );

        let activatedTabCount = await tabRegistryContract.activatedTabCount();
        let ctrlAltDelTabList = await tabRegistryContract.getCtrlAltDelTabList();
        let depeggedTabs = bytes3ToString(ctrlAltDelTabList);

        for (let n = 0; n < activatedTabCount; n++) {
            let t = await tabRegistryContract.tabList(n);
            let tabCode = ethers.utils.toUtf8String(t);
            let bFrozen = await tabRegistryContract.frozenTabs(t);
            let dbTab = tabMap[tabCode]? tabMap[tabCode]: {
                tab_name: tabCode,
                tab_code: ethers.utils.hexDataSlice(ethers.utils.formatBytes32String(tabCode), 0, 3),
                is_clt_alt_del: false,
                is_tab: true,
                frozen: bFrozen
            };
            if (depeggedTabs.includes(ethers.utils.toUtf8String(t))) {
                dbTab.is_clt_alt_del = true;
            } else {
                dbTab.is_clt_alt_del = false;
            }
            dbTab.is_tab = true;
            dbTab.frozen = bFrozen;
            const existedDbTab = await prisma.tab_registry.findUnique({
                where: {
                    tab_name: tabCode
                }
            });
            if (existedDbTab) {
                const result = await prisma.tab_registry.updateMany({
                    where: {
                        tab_name: tabCode
                    },
                    data: dbTab
                });
                dbTab.id = existedDbTab.id;
                dbTab.missing_count = existedDbTab.missing_count;
                dbTab.revival_count = existedDbTab.revival_count;
            } else {
                dbTab.id = crypto.randomUUID();
                dbTab.missing_count = 0;
                dbTab.revival_count = 0;
                const result = await prisma.tab_registry.create({
                    data: dbTab
                });
                logger.info("New tab: "+ dbTab.tab_name);
            }
            tabMap[tabCode] = dbTab;
        }

        // read auth table
        let authRecs = await prisma.auth.findMany();
        for(let n=0; n < authRecs.length; n++) {
            if (provMap[authRecs[n].user_id]) { // matched provider & save auth details
                let authDetails = {
                    api_token: authRecs[n].api_token,
                    updated_datetime: authRecs[n].updated_datetime
                }
                provMap[authRecs[n].user_id].auth = authDetails;
            }
        }

        logger.info("cacheParamsJob is completed.");
    } catch (error) {
        logger.error(error);
    }
};

function getProviderDetails() {
    let d = {};
    for(let p in provMap) {
        d[p] = {
            id: provMap[p].id,
            index: provMap[p].index,
            created_datetime: provMap[p].created_datetime,
            updated_datetime: provMap[p].updated_datetime,
            pub_address: provMap[p].pub_address,
            activated_since_block: provMap[p].activated_since_block,
            activated_timestamp: provMap[p].activated_timestamp,
            disabled_since_block: provMap[p].disabled_since_block,
            disabled_timestamp: provMap[p].disabled_timestamp,
            paused: provMap[p].paused,
            payment_term_block_count: provMap[p].payment_term_block_count,
            payment_token_address: provMap[p].payment_token_address,
            payment_amount: provMap[p].payment_amount,
            block_count_per_feed: provMap[p].block_count_per_feed,
            feed_size: provMap[p].feed_size,
            whitelisted_ip: provMap[p].whitelisted_ip,
            auth: provMap[p].auth? true: false
        }
    }
    return d;
}

async function getTabDetails() {
    let jsonData = [];
    let tabs = await prisma.tab_registry.findMany({
        orderBy: {
            tab_name: 'asc'
        }
    });
    for(let n=0; n < tabs.length; n++) {
        let t = tabs[n];
        jsonData.push({
            code: t.tab_name,
            bytes3: t.tab_code,
            name: t.curr_name,
            activated: t.is_tab,
            frozen: t.frozen,
            cltAltDel: t.is_clt_alt_del
        });
    }
    return jsonData;
}

/*
1 fixer.io sample:
{
    "success": true,
    "symbols": {
        "AED": "United Arab Emirates Dirham",
        "AFN": "Afghan Afghani",
        "ALL": "Albanian Lek",
        ...
        ...
    }
}

2 fastforex.io sample:
{
    "currencies": {
        "AED": "United Arab Emirates Dirham",
        "AFN": "Afghan Afghani",
        "ALL": "Albanian Lek",
        ...
        ...
    },
    "ms": 3
}

3 apilayer.com sample:
{
    "success": true,
    "symbols": {
        "AED": "United Arab Emirates Dirham",
        "AFN": "Afghan Afghani",
        "ALL": "Albanian Lek",
        ...
        ...
    }
}
*/
async function retrieveAndSaveCurrencySymbols(CURR_DETAILS) {
    let N = Math.floor(Math.random() * 3) + 1; // random number of 1, 2 or 3
    let fetchUrl = CURR_DETAILS['CURR_DETAILS_URL'+N];
    let apiKey = CURR_DETAILS['CURR_DETAILS_URL'+N+'_APIKEY'];
    let getOptions = {
        method: 'GET',
        headers: {
            'apiKey': apiKey
        }
    };
    try {
        console.log("Fetching currency symbols, selection "+N+', URL: '+fetchUrl);
        let res;
        if (apiKey)
            res = await axios.get(fetchUrl, getOptions);
        else
            res = await axios.get(fetchUrl);

        if (res.data) {
            let symbols;
            if (N == 2) // fastforex
                symbols = res.data.currencies;
            else
                symbols = res.data.symbols;
            console.log("Fetched "+Object.keys(symbols).length);
            for(let code in symbols) {
                let existedTab = await prisma.tab_registry.findUnique({
                    where: {
                        tab_name: code
                    }
                });
                if (existedTab) {
                    if (!existedTab.curr_name) { // if existing record has blank curr_name, update it
                        await prisma.tab_registry.update({
                            where: {
                                id: existedTab.id
                            },
                            data: {
                                curr_name: symbols[code]
                            }
                        });
                        console.log('updated '+existedTab.tab_name+' '+symbols[code]);
                    }
                } else {
                    let newTab = await prisma.tab_registry.create({
                        data: {
                            id: crypto.randomUUID(),
                            tab_name: code,
                            tab_code: ethers.utils.hexDataSlice(ethers.utils.formatBytes32String(code), 0, 3),
                            curr_name: symbols[code],
                            is_clt_alt_del: false,
                            is_tab: false,
                            frozen: false,
                            missing_count: 0,
                            revival_count: 0
                        }
                    });
                    console.log('newTab: '+newTab.tab_name);
                }
            }
        }
    } catch(e) {
        logger.error(e);
        logger.error('Failed to retrieveAndSaveCurrencySymbols with provider #'+N+', fetchUrl: '+fetchUrl);
    }
}

exports.params = {
    cacheParamsJob,
    getProviderDetails,
    getTabDetails,
    retrieveAndSaveCurrencySymbols,
    provMap,
    tabMap
};