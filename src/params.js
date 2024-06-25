const logger = require('./logger');
const {prisma} = require('./prisma');
const ethers = require('ethers');
const multicall = require('ethers-multicall-provider');
const crypto = require('crypto');
const { default: axios } = require('axios');

var provMap = {};
var tabMap = {};
var configMap = {};

function bytes3ToString(arrBytes3) {
    var arrString = [];
    for (let i = 0; i < arrBytes3.length; i++) {
        if (arrBytes3[i] != 0)
            arrString.push(ethers.toUtf8String(arrBytes3[i]));
    }
    return arrString;
}

async function loadDBProvider() {
    const providers = await prisma.feed_provider.findMany();
    for(let i=0; i < providers.length; i++) {
        let p = providers[i];
        provMap[p.pub_address] = {
            id: p.id,
            created_datetime: p.created_datetime,
            updated_datetime: p.updated_datetime,
            pub_address: p.pub_address,
            index: p.index,
            activated_since_block: p.activated_since_block,
            activated_timestamp: p.activated_timestamp,
            disabled_since_block: p.disabled_since_block,
            disabled_timestamp: p.disabled_timestamp,
            paused: p.paused,
            payment_token_address: p.payment_token_address,
            payment_amount_per_feed: p.payment_amount_per_feed,
            block_count_per_feed: p.block_count_per_feed,
            feed_size: p.feed_size,
            whitelisted_ip: p.whitelisted_ip
        };
    }
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
}

async function loadDBTabRegistry() {
    const tabList = await prisma.tab_registry.findMany();
    for(let i=0; i < tabList.length; i++) {
        let t = tabList[i];
        let dbTab = {
            id: t.id,
            tab_name: t.tab_name,
            tab_code: t.tab_code,
            curr_name: t.curr_name,
            is_clt_alt_del: t.is_clt_alt_del,
            is_tab: t.is_tab,
            missing_count: t.missing_count,
            revival_count: t.revival_count,
            frozen: t.frozen
        }
        tabMap[t.tab_name] = dbTab;
    }
}

async function cacheConfigJob(BC_NODE_URL, BC_CONFIG_CONTRACT) {
    logger.info("cacheConfigJob is started...");
    try {
        const provider = multicall.MulticallWrapper.wrap(new ethers.JsonRpcProvider(BC_NODE_URL, undefined, {staticNetwork: true}));
        let configContractABI = [
            "function reserveParams(bytes32) external view returns(uint256,uint256,uint256)",
            "function tabParams(bytes3) external view returns(uint256,uint256)"
        ];
        let configContract = new ethers.Contract(
            BC_CONFIG_CONTRACT,
            configContractABI,
            provider
        );
        let confPromises = [
            configContract.reserveParams(ethers.keccak256(ethers.toUtf8Bytes("CBTC"))),
            configContract.reserveParams(ethers.keccak256(ethers.toUtf8Bytes("WBTC")))
        ];
        let allTabs = await prisma.tab_registry.findMany({
            where: {
                is_tab: {
                    equals: true
                }
            }
        });
        for(let i=0; i < allTabs.length; i++) {
            confPromises.push(configContract.tabParams(allTabs[i].tab_code));
        }
        
        Promise.all(confPromises).then( (results) => {
            configMap.CBTC = {
                processFeeRate: BigInt(results[0][0]),
                minReserveRatio: BigInt(results[0][1]),
                liquidationRatio: BigInt(results[0][2])
            };
            configMap.WBTC = {
                processFeeRate: BigInt(results[1][0]),
                minReserveRatio: BigInt(results[1][1]),
                liquidationRatio: BigInt(results[1][2])
            };

            let tabIndex = 2;
            let curr = '';
            for(let i=0; i < allTabs.length; i++) {
                curr = allTabs[i].tab_name; // XXX currency code
                configMap[curr] = {
                    riskPenaltyPerFrame: BigInt(results[tabIndex][0]),
                    processFeeRate: BigInt(results[tabIndex][1])
                };
                tabIndex++;
            }
        }).catch((e) => {
            logger.error(e);
        });
        
    } catch(error) {
        logger.error(error);
    }
}

async function cacheTopVaultJob(BC_NODE_URL, BC_VAULT_MANAGER_CONTRACT) {
    logger.info("cacheTopVaultJob is started...");
    try {
        const provider = multicall.MulticallWrapper.wrap(new ethers.JsonRpcProvider(BC_NODE_URL, undefined, {staticNetwork: true}));
        let vaultManagerContractABI = [
            'function getOwnerList() external view returns(address[] memory)',
            'function getAllVaultIDByOwner(address) external view returns(uint256[] memory)',
            'function vaults(address,uint256) external view returns(address,uint256,address,uint256,uint256,uint256)'
        ];
        let vaultManagerContract = new ethers.Contract(
            BC_VAULT_MANAGER_CONTRACT,
            vaultManagerContractABI,
            provider
        );
        let tabContractABI = [
            'function tabCode() external view returns(bytes3)'
        ];
        let addrTabMap = {}; // address: bytes3
        const ownerList = await vaultManagerContract.getOwnerList();
        logger.info('ownerList length: '+ownerList.length);
        let topMap = {};

        for(let i=0; i < ownerList.length; i++) {
            let addr = ownerList[i];
            let ids = await vaultManagerContract.getAllVaultIDByOwner(addr);
            let promises = [];
            for(let k=0; k < ids.length; k++) {
                promises.push(vaultManagerContract.vaults(addr, ids[k]));
            }
            await Promise.all(promises).then(async (results) => {
                for(let j=0; j < results.length; j++) { // each vault belongs to current owner
                    let v = results[j];
                    let tab = '';
                    if (addrTabMap[v[2]] == undefined) { // retrieve tab code(bytes3) of this vault
                        let tabContract = new ethers.Contract(
                            v[2],
                            tabContractABI,
                            provider
                        );
                        tab = ethers.toUtf8String(await tabContract.tabCode());
                        addrTabMap[v[2]] = tab;
                        console.log("Tab "+tab+" address "+v[2]);
                    } else {
                        tab = addrTabMap[v[2]];
                    }
                    if (topMap[tab] == undefined) {
                        topMap[tab] = {
                            'vault_tab': tab,
                            'vault_count': 1,
                            'vault_reserve_qty': BigInt(v[1]) // reserveAmt
                        };
                    } else {
                        topMap[tab].vault_tab = tab;
                        topMap[tab].vault_count = topMap[tab].vault_count + 1;
                        topMap[tab].vault_reserve_qty = topMap[tab].vault_reserve_qty + BigInt(v[1])
                    }
                }
            }).catch((e) => {
                logger.error(e);
            });
        }

        let tabs = Object.keys(topMap);
        logger.info("Top tab count: "+tabs.length);
        
        let sortedList = [];
        if (tabs.length > 0) { 
            sortedList = sortTopTab(topMap);
            if (sortedList.length == 1) {
                if (sortedList[0].vault_tab == 'USD') {
                    sortedList[1] = {
                        'vault_tab': 'EUR',
                        'vault_count': 0,
                        'vault_reserve_qty': 0
                    };
                    sortedList[2] = {
                        'vault_tab': 'JPY',
                        'vault_count': 0,
                        'vault_reserve_qty': 0
                    };
                } else if (sortedList[0].vault_tab == 'EUR') {
                    sortedList[1] = {
                        'vault_tab': 'USD',
                        'vault_count': 0,
                        'vault_reserve_qty': 0
                    };
                    sortedList[2] = {
                        'vault_tab': 'JPY',
                        'vault_count': 0,
                        'vault_reserve_qty': 0
                    };
                } else { 
                    sortedList[1] = {
                        'vault_tab': 'USD',
                        'vault_count': 0,
                        'vault_reserve_qty': 0
                    };
                    sortedList[2] = {
                        'vault_tab': 'EUR',
                        'vault_count': 0,
                        'vault_reserve_qty': 0
                    };
                } 
            } else if (sortedList.length == 2) {
                sortedList[2] = {
                    'vault_tab': get3rdDefTab(sortedList[0].vault_tab, sortedList[1].vault_tab),
                    'vault_count': 0,
                    'vault_reserve_qty': 0
                }
            }
        } else { // show default USD, EUR and JPY
            sortedList[0] = {
                'vault_tab': 'USD',
                'vault_count': 0,
                'vault_reserve_qty': 0
            };
            sortedList[1] = {
                'vault_tab': 'EUR',
                'vault_count': 0,
                'vault_reserve_qty': 0
            };
            sortedList[2] = {
                'vault_tab': 'JPY',
                'vault_count': 0,
                'vault_reserve_qty': 0
            };
        }
        for(let i =0; i < sortedList.length; i++) {
            sortedList[i].vault_count = sortedList[i].vault_count.toString();
            sortedList[i].vault_reserve_qty = sortedList[i].vault_reserve_qty.toString();
        }
        configMap.popularTabs = sortedList;
    } catch(error) {
        logger.error(error);
    }
}

function sortTopTab(tabs) {
    let sortedTopTab = [];
    let keys = Object.keys(tabs);
    for(let i=0; i < keys.length; i++) {
        sortedTopTab.push(tabs[keys[i]]);
    }
    sortedTopTab.sort((a, b) => {
        if (b.vault_count == a.vault_count) {
            if (b.vault_reserve_qty > a.vault_reserve_qty)
                return 1;
            else
                return -1;
        } else if (b.vault_count > a.vault_count)
            return 1;
        else
            return -1;
    });
    return sortedTopTab;
}

function get3rdDefTab(firstTab, secondTab) {
    let defTab = {'USD':0, 'EUR':0, 'JPY':0};
    defTab[firstTab] == 1;
    defTab[secondTab] == 1;
    for(let key in defTab) {
        if (defTab[key] == 0) {
            return key;
        }
    }
    return defTab[0]; // not likely to reach here
}

async function cacheParamsJob (BC_NODE_URL, BC_PRICE_ORACLE_MANAGER_CONTRACT, BC_TAB_REGISTRY_CONTRACT, bLoadDbIfOnChainFailure) {
    logger.info("cacheParamsJob is started...");
    try {
        const provider = multicall.MulticallWrapper.wrap(new ethers.JsonRpcProvider(BC_NODE_URL, undefined, {staticNetwork: true}));

        // read oracle provider related data
        let oracleManagerContractABI = [
            "function providerCount() external view returns(uint256)",
            "function providerList(uint256) external view returns(address)",
            "function providers(address) external view returns(uint256,uint256,uint256,uint256,uint256,bool)",
            "function providerInfo(address) external view returns(address,uint256,uint256,uint256,bytes32)",
            "function getConfig() external view returns(uint256,uint256,uint256)"
        ];
        let oracleManagerContract = new ethers.Contract(
            BC_PRICE_ORACLE_MANAGER_CONTRACT,
            oracleManagerContractABI,
            provider
        );

        let providerCount = 0;
        let provConfPromises = [
            oracleManagerContract.providerCount(),
            oracleManagerContract.getConfig()
        ];
        await Promise.all(provConfPromises).then( (results) => {
            providerCount = results[0];
            logger.info("providerCount: "+providerCount);
            configs = results[1];
            if (configs.length > 0) {
                configMap.defBlockGenerationTimeInSecond = BigInt(configs[0]);
                configMap.movementDelta = BigInt(configs[1]);
                configMap.inactivePeriod = BigInt(configs[2]);
                logger.info("Updated configMap from on-chain data");
            }
            if (configMap.defBlockGenerationTimeInSecond == 0 || configMap.defBlockGenerationTimeInSecond == '')
                configMap.defBlockGenerationTimeInSecond = BigInt(12);
            if (configMap.movementDelta == 0 || configMap.movementDelta == '')
                configMap.movementDelta = BigInt(500);
            if (configMap.inactivePeriod == 0 || configMap.inactivePeriod == '')
                configMap.inactivePeriod = BigInt(3600);
        }).catch((error) => {
            logger.error(error);
            if (bLoadDbIfOnChainFailure) {
                configMap.defBlockGenerationTimeInSecond = BigInt(12);
                configMap.movementDelta = BigInt(500);
                configMap.inactivePeriod = BigInt(3600);
                loadDBProvider();
                loadDBTabRegistry();
                logger.info('Failed to retrieve on-chain data, loaded DB state...');
            }
        });

        let providerPromises = [];
        for(let n = 0; n < providerCount; n++)
            providerPromises.push(Promise.resolve(oracleManagerContract.providerList(n)));

        Promise.all(providerPromises).then(async (results) => {
            for (let n = 0; n < providerCount; n++) {
                let provAddr = results[n];
                let dateNow = new Date();
                let now = Math.floor(dateNow.getTime() / 1000);

                let dbProvider = provMap[provAddr]? provMap[provAddr]: {
                    updated_datetime: dateNow.toISOString(),
                    pub_address: provAddr
                };
                
                Promise.all([
                    oracleManagerContract.providers(provAddr),
                    oracleManagerContract.providerInfo(provAddr)
                ]).then(async (results) => {
                    delete dbProvider['auth'];
                    let prov = results[0];
                    let provInfo = results[1];

                    dbProvider.index = prov[0].toString();
                    dbProvider.activated_since_block = prov[1].toString();
                    dbProvider.activated_timestamp = prov[2].toString();
                    dbProvider.disabled_since_block = prov[3].toString();
                    dbProvider.disabled_timestamp = prov[4].toString();
                    dbProvider.paused = prov[5];

                    // disabledOnBlockId == 0 && disabledTimestamp == 0 && !paused && current >= activatedTimestamp
                    if (prov[3] == 0 && prov[4] == 0 && !dbProvider.paused && now >= Number(dbProvider.activated_timestamp)) {
                        // struct Info {
                        //     address paymentTokenAddress;
                        //     uint256 paymentAmt;
                        //     uint256 blockCountPerFeed;
                        //     uint256 feedSize;
                        //     bytes32 whitelistedIPAddr;
                        // }
                        dbProvider.payment_token_address = provInfo[0];
                        dbProvider.payment_amount_per_feed = provInfo[1].toString();
                        dbProvider.block_count_per_feed = provInfo[2].toString();
                        dbProvider.feed_size = provInfo[3].toString();
                        dbProvider.whitelisted_ip = provInfo[4] ? ethers.decodeBytes32String(provInfo[4]) : ''
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

                }).catch((error) => {
                    logger.error(error);
                });
            }
        }).catch((error) => {
            logger.error(error);
        });

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

        let activatedTabCount = 0;
        let depeggedTabs;
        Promise.all([
            tabRegistryContract.activatedTabCount(),
            tabRegistryContract.getCtrlAltDelTabList()
        ]).then(async (results) => {
            activatedTabCount = results[0];
            logger.info("activatedTabCount: "+activatedTabCount);
            depeggedTabs = bytes3ToString(results[1]);
            
            let tabPromises = [];
            for(let n = 0; n < activatedTabCount; n++)
                tabPromises.push(Promise.resolve(tabRegistryContract.tabList(n)));

            Promise.all(tabPromises).then(async (tabResults) => {
                let frozenPromises = [];
                for(let n = 0; n < activatedTabCount; n++)
                    frozenPromises.push(Promise.resolve(tabRegistryContract.frozenTabs(tabResults[n])));

                Promise.all(frozenPromises).then(async (frozenResults) => {
                    for (let n = 0; n < activatedTabCount; n++) {
                        let t = tabResults[n];
                        let tabCode = ethers.toUtf8String(t);
                        let bFrozen = frozenResults[n];
                        let dbTab = tabMap[tabCode]? tabMap[tabCode]: {
                            tab_name: tabCode,
                            tab_code: ethers.dataSlice(ethers.toUtf8Bytes(tabCode), 0, 3),
                            is_clt_alt_del: false,
                            is_tab: true,
                            frozen: bFrozen
                        };
                        if (depeggedTabs.includes(ethers.toUtf8String(t))) {
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

                    logger.info("cacheParamsJob is completed.");

                }).catch((err) => {
                    logger.error(err);
                });
            })            
    
        }).catch((error) => {
            logger.error(error);
        });

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
            payment_token_address: provMap[p].payment_token_address,
            payment_amount_per_feed: provMap[p].payment_amount_per_feed,
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
            let symbols = {};
            if (fetchUrl.indexOf('api.currencylayer.com') > -1) { // https://currencylayer.com/documentation
                symbols = res.data.currencies;
            } else if (fetchUrl.indexOf('exchangerate-api.com') > -1) { // https://www.exchangerate-api.com/docs/supported-codes-endpoint
                let currencies = res.data.supported_codes;
                for(let i=0; i < currencies.length; i++) {
                    symbols[ currencies[i][0] ] = currencies[i][1];
                }
            } else if (fetchUrl.indexOf('api.currencyapi.com') > -1) { // https://currencyapi.com/docs/currencies#supported-currencies
                let data = res.data.data;
                for(let code in data) {
                    symbols[ code ] = data[code].name;
                }
            } else {
                logger.error("Unhandled fetchUrl: "+fetchUrl);
                return;
            }
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
                    if (code.length == 3) {
                        let newTab = await prisma.tab_registry.create({
                            data: {
                                id: crypto.randomUUID(),
                                tab_name: code,
                                tab_code: ethers.dataSlice(ethers.toUtf8Bytes(code), 0, 3),
                                curr_name: symbols[code],
                                is_clt_alt_del: false,
                                is_tab: false,
                                frozen: false,
                                missing_count: 0,
                                revival_count: 0
                            }
                        });
                        console.log('newTab: '+newTab.tab_name);
                    } else {
                        logger.info("Skipped "+code+" "+symbols[code]);
                    }
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
    cacheConfigJob,
    cacheTopVaultJob,
    getProviderDetails,
    getTabDetails,
    retrieveAndSaveCurrencySymbols,
    provMap,
    tabMap,
    configMap
};