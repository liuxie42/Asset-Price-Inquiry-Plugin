"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const block_basekit_server_api_1 = require("@lark-opdev/block-basekit-server-api");
const { t } = block_basekit_server_api_1.field;
// ==================== 高性能LRU缓存实现 ====================
class HighPerformanceLRUCache {
    constructor(maxSize = 1000) {
        this.cache = new Map();
        this.hitCount = 0;
        this.missCount = 0;
        this.maxSize = maxSize;
    }
    set(key, value) {
        if (this.cache.has(key)) {
            const item = this.cache.get(key);
            item.value = value;
            item.timestamp = Date.now();
            item.accessCount++;
            this.cache.delete(key);
            this.cache.set(key, item);
        }
        else {
            if (this.cache.size >= this.maxSize) {
                const firstKey = this.cache.keys().next().value;
                this.cache.delete(firstKey);
            }
            this.cache.set(key, {
                value,
                timestamp: Date.now(),
                accessCount: 1
            });
        }
    }
    get(key, ttl) {
        const item = this.cache.get(key);
        if (!item) {
            this.missCount++;
            return null;
        }
        if (Date.now() - item.timestamp > ttl) {
            this.cache.delete(key);
            this.missCount++;
            return null;
        }
        item.accessCount++;
        item.timestamp = Date.now();
        this.cache.delete(key);
        this.cache.set(key, item);
        this.hitCount++;
        return item.value;
    }
    clear() {
        this.cache.clear();
        this.hitCount = 0;
        this.missCount = 0;
    }
    getStats() {
        const total = this.hitCount + this.missCount;
        return {
            size: this.cache.size,
            hitRate: total > 0 ? (this.hitCount / total * 100).toFixed(2) + '%' : '0%',
            hitCount: this.hitCount,
            missCount: this.missCount
        };
    }
    // 添加缓存清理方法
    cleanup(ttl) {
        const now = Date.now();
        for (const [key, item] of this.cache.entries()) {
            if (now - item.timestamp > ttl) {
                this.cache.delete(key);
            }
        }
    }
}
// ==================== 优化后的配置常量 ====================
const CONFIG = {
    PRICE_RANGE: { MIN: 0.01, MAX: 10000 },
    REQUEST_TIMEOUT: 8000,
    RETRY_COUNT: 2,
    RETRY_DELAY: 500,
    PRICE_UNAVAILABLE: null,
    CACHE_TTL: 45000,
    BATCH_CACHE_TTL: 180000,
    MAX_CACHE_SIZE: 500,
    CACHE_CLEANUP_INTERVAL: 120000,
    BATCH_DELAY: 20,
    MAX_CONCURRENT_REQUESTS: 5,
};
// ==================== 优化后的缓存系统 ====================
const requestCache = new HighPerformanceLRUCache(CONFIG.MAX_CACHE_SIZE);
const batchResultCache = new HighPerformanceLRUCache(CONFIG.MAX_CACHE_SIZE);
const pendingRequests = new Map();
// 请求去重和并发控制
let activeRequestCount = 0;
const requestQueue = [];
// 并发控制函数 - 添加性能监控
async function executeWithConcurrencyControl(task) {
    const startTime = Date.now();
    return new Promise((resolve, reject) => {
        const wrappedTask = async () => {
            try {
                activeRequestCount++;
                performanceMonitor.updateConcurrencyMetrics(activeRequestCount, requestQueue.length);
                const result = await task();
                performanceMonitor.recordRequest(startTime, true);
                resolve(result);
            }
            catch (error) {
                performanceMonitor.recordRequest(startTime, false);
                reject(error);
            }
            finally {
                activeRequestCount--;
                performanceMonitor.updateConcurrencyMetrics(activeRequestCount, requestQueue.length);
                processQueue();
            }
        };
        if (activeRequestCount < CONFIG.MAX_CONCURRENT_REQUESTS) {
            wrappedTask();
        }
        else {
            requestQueue.push(wrappedTask);
            performanceMonitor.updateConcurrencyMetrics(activeRequestCount, requestQueue.length);
        }
    });
}
// 处理队列中的请求
function processQueue() {
    while (requestQueue.length > 0 && activeRequestCount < CONFIG.MAX_CONCURRENT_REQUESTS) {
        const nextTask = requestQueue.shift();
        if (nextTask) {
            nextTask();
        }
    }
}
// 预编译正则表达式
const PATTERNS = {
    FUND_CODE: /^\d{6}$/,
    STOCK_CODE: /^(sh|sz|hk|us)[a-z0-9]+$/i,
    PURE_NUMBER: /^\d+\.?\d*$/,
    DATE_FORMAT: /^\d{4}-\d{2}-\d{2}$/,
    PERCENTAGE: /^[+-]?\d*\.?\d+%$/,
    PRICE_PATTERN: /(\d+\.\d{2,4})/,
    DATE_PATTERNS: [
        /(\d{4}[-\/]\d{1,2}[-\/]\d{1,2})/g,
        /(\d{4}年\d{1,2}月\d{1,2}日)/g,
        /更新时间[^0-9]*(\d{4}[-\/]\d{1,2}[-\/]\d{1,2})/gi,
        /净值日期[^0-9]*(\d{4}[-\/]\d{1,2}[-\/]\d{1,2})/gi
    ]
};
// ==================== 工具函数 ====================
// 缓存清理函数
function cleanExpiredCache() {
    requestCache.cleanup(CONFIG.CACHE_TTL);
    batchResultCache.cleanup(CONFIG.BATCH_CACHE_TTL);
}
// 启动定期缓存清理
setInterval(cleanExpiredCache, CONFIG.CACHE_CLEANUP_INTERVAL);
// 网络请求函数 - 带重试机制和并发控制
async function fetchWithRetry(url, options = {}) {
    return executeWithConcurrencyControl(async () => {
        let lastError;
        for (let attempt = 1; attempt <= CONFIG.RETRY_COUNT; attempt++) {
            try {
                // 兼容性处理：检查 AbortController 是否可用
                let timeoutId = null;
                let requestOptions = { ...options };
                if (typeof AbortController !== 'undefined') {
                    const controller = new AbortController();
                    timeoutId = setTimeout(() => controller.abort(), CONFIG.REQUEST_TIMEOUT);
                    requestOptions.signal = controller.signal;
                }
                const response = await fetch(url, requestOptions);
                if (timeoutId) {
                    clearTimeout(timeoutId);
                }
                if (response.ok) {
                    return response;
                }
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            catch (error) {
                lastError = error;
                if (attempt < CONFIG.RETRY_COUNT) {
                    const delay = CONFIG.RETRY_DELAY * Math.pow(2, attempt - 1);
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }
        }
        throw lastError;
    });
}
// 请求去重函数
async function fetchWithDeduplication(url, options = {}) {
    const cacheKey = `${url}_${JSON.stringify(options)}`;
    if (pendingRequests.has(cacheKey)) {
        return await pendingRequests.get(cacheKey);
    }
    const cached = requestCache.get(cacheKey, CONFIG.CACHE_TTL);
    if (cached) {
        return cached;
    }
    const requestPromise = (async () => {
        try {
            const response = await fetchWithRetry(url, options);
            const text = await response.text();
            requestCache.set(cacheKey, text);
            return text;
        }
        finally {
            pendingRequests.delete(cacheKey);
        }
    })();
    pendingRequests.set(cacheKey, requestPromise);
    return await requestPromise;
}
// 基金数据获取函数
async function fetchFundData(fundCode) {
    return await fetchWithDeduplication(`https://fund.eastmoney.com/${fundCode}.html`, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
    });
}
// ==================== 验证函数 ====================
function validateStockCode(code) {
    const trimmedCode = code.trim().toLowerCase();
    if (!trimmedCode) {
        return {
            isValid: false,
            type: 'unknown',
            message: '请输入有效的股票代码（如：sh000001、sz000001、hk00700、usAAPL）或基金代码（如：000311）'
        };
    }
    if (PATTERNS.FUND_CODE.test(trimmedCode)) {
        return { isValid: true, type: 'fund' };
    }
    if (PATTERNS.STOCK_CODE.test(trimmedCode) || PATTERNS.FUND_CODE.test(trimmedCode)) {
        return { isValid: true, type: 'stock' };
    }
    return {
        isValid: false,
        type: 'unknown',
        message: '请输入有效的股票代码（如：sh000001、sz000001、hk00700、usAAPL）或基金代码（如：000311）'
    };
}
// 统一的名称验证函数
function isValidStockName(name) {
    if (!name || name.length === 0)
        return false;
    if (PATTERNS.PURE_NUMBER.test(name))
        return false;
    if (name.includes('%'))
        return false;
    if (PATTERNS.DATE_FORMAT.test(name))
        return false;
    if (name.endsWith('OQ') || name.endsWith('oq'))
        return false;
    return true;
}
// ==================== 解析函数 ====================
// 基金名称解析 - 优化版本
function parseFundName(html, fundCode) {
    // 使用 indexOf 替代正则表达式进行初步筛选
    const titleStart = html.indexOf('<title>');
    const titleEnd = html.indexOf('</title>');
    if (titleStart !== -1 && titleEnd !== -1) {
        const titleContent = html.substring(titleStart + 7, titleEnd);
        // 查找基金名称的关键词位置
        const fundIndex = titleContent.indexOf('基金');
        const netValueIndex = titleContent.indexOf('净值');
        if (fundIndex !== -1 || netValueIndex !== -1) {
            // 提取基金名称部分
            let name = titleContent;
            // 移除括号内容
            const parenStart = name.indexOf('(');
            if (parenStart !== -1) {
                name = name.substring(0, parenStart);
            }
            name = name.trim();
            if (name && name !== `基金${fundCode}`) {
                return name;
            }
        }
    }
    // 备用方案：查找 h1 标签
    const h1Start = html.indexOf('<h1');
    if (h1Start !== -1) {
        const h1ContentStart = html.indexOf('>', h1Start) + 1;
        const h1End = html.indexOf('</h1>', h1ContentStart);
        if (h1ContentStart > 0 && h1End !== -1) {
            const name = html.substring(h1ContentStart, h1End).trim();
            if (name && name !== `基金${fundCode}`) {
                return name;
            }
        }
    }
    return `基金${fundCode}`;
}
// 基金价格解析 - 优化版本
function parseFundPrice(html) {
    // 使用 indexOf 查找关键词位置
    const keywords = ['单位净值', '最新净值'];
    for (const keyword of keywords) {
        const keywordIndex = html.indexOf(keyword);
        if (keywordIndex !== -1) {
            // 在关键词后查找数字
            const searchStart = keywordIndex + keyword.length;
            const searchText = html.substring(searchStart, searchStart + 50); // 限制搜索范围
            // 查找价格模式
            const match = searchText.match(/(\d+\.\d{2,4})/);
            if (match?.[1]) {
                const price = parseFloat(match[1]);
                if (!isNaN(price) && price >= CONFIG.PRICE_RANGE.MIN && price <= CONFIG.PRICE_RANGE.MAX) {
                    return price;
                }
            }
        }
    }
    // 备用方案：使用正则表达式
    const priceMatch = html.match(PATTERNS.PRICE_PATTERN);
    if (priceMatch?.[1]) {
        const price = parseFloat(priceMatch[1]);
        if (!isNaN(price) && price >= CONFIG.PRICE_RANGE.MIN && price <= CONFIG.PRICE_RANGE.MAX) {
            return price;
        }
    }
    return -1;
}
// 基金日期解析 - 优化版本
function parseFundDate(html) {
    // 使用 indexOf 查找日期关键词
    const dateKeywords = ['更新时间', '净值日期'];
    for (const keyword of dateKeywords) {
        const keywordIndex = html.indexOf(keyword);
        if (keywordIndex !== -1) {
            const searchStart = keywordIndex + keyword.length;
            const searchText = html.substring(searchStart, searchStart + 30);
            // 查找日期格式
            const dateMatch = searchText.match(/(\d{4}[-\/]\d{1,2}[-\/]\d{1,2})/);
            if (dateMatch?.[1]) {
                return dateMatch[1].replace(/\//g, '-');
            }
        }
    }
    // 备用方案：查找任何日期格式
    for (const pattern of PATTERNS.DATE_PATTERNS) {
        const dateMatch = html.match(pattern);
        if (dateMatch?.[1]) {
            return dateMatch[1].replace(/年|月/g, '-').replace(/日/g, '').replace(/\//g, '-');
        }
    }
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
// 股票交易日期获取
function getActualTradeDate(dataArr) {
    if (dataArr.length > 30 && dataArr[30] && /^\d{8}$/.test(dataArr[30])) {
        const dateStr = dataArr[30];
        return `${dateStr.substring(0, 4)}-${dateStr.substring(4, 6)}-${dateStr.substring(6, 8)}`;
    }
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
// 股票名称提取 - 优化版本
function extractStockNameFromQtData(dataArr) {
    if (dataArr.length < 2)
        return '';
    const stockName = dataArr[1]?.trim();
    if (stockName && stockName.length > 0) {
        let cleanedName = stockName;
        if (cleanedName.endsWith('OQ') || cleanedName.endsWith('oq')) {
            cleanedName = cleanedName.slice(0, -2).trim();
        }
        if (isValidStockName(cleanedName)) {
            return cleanedName;
        }
    }
    return '';
}
// 价格提取 - 优化版本
function extractPriceFromQtData(dataArr) {
    if (dataArr.length < 4)
        return 0;
    const priceStr = dataArr[3]?.trim();
    if (priceStr) {
        const price = parseFloat(priceStr);
        if (!isNaN(price) && price > 0) {
            return price;
        }
    }
    return 0;
}
// 股票数据解析 - 优化版本
function parseStockDataFromQtGtimg(responseText) {
    try {
        // 使用 indexOf 查找变量定义的位置
        const varStart = responseText.indexOf('v_s_');
        if (varStart === -1) {
            return {
                name: '',
                price: 0,
                success: false,
                error: '数据格式不匹配'
            };
        }
        // 查找等号和引号的位置
        const equalIndex = responseText.indexOf('=', varStart);
        const quoteStart = responseText.indexOf('"', equalIndex);
        const quoteEnd = responseText.indexOf('"', quoteStart + 1);
        if (equalIndex === -1 || quoteStart === -1 || quoteEnd === -1) {
            return {
                name: '',
                price: 0,
                success: false,
                error: '数据格式不匹配'
            };
        }
        const dataString = responseText.substring(quoteStart + 1, quoteEnd);
        const dataArr = dataString.split('~');
        if (dataArr.length < 4) {
            return {
                name: '',
                price: 0,
                success: false,
                error: `数据字段不足，仅有${dataArr.length}个字段`
            };
        }
        const stockName = extractStockNameFromQtData(dataArr);
        const price = extractPriceFromQtData(dataArr);
        if (!stockName) {
            return {
                name: '',
                price: price,
                success: false,
                error: '股票名称为空或无效'
            };
        }
        return {
            name: stockName,
            price: price,
            success: true
        };
    }
    catch (error) {
        return {
            name: '',
            price: 0,
            success: false,
            error: `解析异常: ${String(error)}`
        };
    }
}
// ==================== 查询函数 ====================
// 基金查询
async function queryFund(fundCode) {
    try {
        const html = await fetchFundData(fundCode);
        const fundName = parseFundName(html, fundCode);
        const netValue = parseFundPrice(html);
        const valueDate = parseFundDate(html);
        if (!fundName || fundName.trim() === '') {
            return {
                code: block_basekit_server_api_1.FieldCode.Error,
                message: `基金代码 ${fundCode} 无法解析基金名称`,
                hasValidData: false
            };
        }
        if (netValue === -1) {
            // 基金净值获取失败，设为-1
        }
        const hasValidData = fundName && fundName !== `基金${fundCode}` && netValue > 0;
        return {
            code: block_basekit_server_api_1.FieldCode.Success,
            data: {
                id: `fund_${fundCode}_${Date.now()}`,
                symbol: fundCode,
                name: fundName,
                price: netValue,
                date: valueDate,
            },
            hasValidData: hasValidData
        };
    }
    catch (error) {
        return {
            code: block_basekit_server_api_1.FieldCode.Error,
            message: `基金查询异常: ${String(error)}`,
            hasValidData: false
        };
    }
}
// 股票查询
async function queryStock(stockCode) {
    try {
        const symbol = stockCode;
        let querySymbol = `s_${symbol}`;
        if (PATTERNS.FUND_CODE.test(symbol)) {
            querySymbol = `s_sh${symbol}`;
        }
        const response = await fetchWithRetry(`https://qt.gtimg.cn/q=${querySymbol}`, {
            headers: {
                'Referer': 'https://finance.qq.com/',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });
        const arrayBuffer = await response.arrayBuffer();
        const decoder = new TextDecoder('gbk');
        const text = decoder.decode(arrayBuffer);
        if (text.includes('pv_none_match')) {
            if (PATTERNS.FUND_CODE.test(symbol) && querySymbol.includes('sh')) {
                return queryStock(`sz${symbol}`);
            }
            return {
                code: block_basekit_server_api_1.FieldCode.Error,
                message: `股票代码 ${stockCode} 无法找到匹配数据，请检查代码格式`
            };
        }
        const parseResult = parseStockDataFromQtGtimg(text);
        if (!parseResult.success) {
            return {
                code: block_basekit_server_api_1.FieldCode.Error,
                message: parseResult.error || '股票数据解析失败'
            };
        }
        const variableMatch = text.match(/v_s_[^=]+="([^"]+)"/);
        const dataArr = variableMatch ? variableMatch[1].split('~') : [];
        const actualTradeDate = getActualTradeDate(dataArr);
        return {
            code: block_basekit_server_api_1.FieldCode.Success,
            data: {
                id: `stock_${stockCode}_${Date.now()}`,
                symbol: stockCode,
                name: parseResult.name,
                price: parseResult.price,
                date: actualTradeDate,
                status: '查询成功'
            }
        };
    }
    catch (error) {
        return {
            code: block_basekit_server_api_1.FieldCode.Error,
            message: `股票查询异常: ${String(error)}`
        };
    }
}
// ==================== 批量查询优化器 ====================
class BatchQueryOptimizer {
    constructor() {
        this.queryQueue = new Map();
        this.processingTimer = null;
    }
    static getInstance() {
        if (!BatchQueryOptimizer.instance) {
            BatchQueryOptimizer.instance = new BatchQueryOptimizer();
        }
        return BatchQueryOptimizer.instance;
    }
    async addQuery(stockCode) {
        return new Promise((resolve, reject) => {
            const normalizedCode = this.normalizeStockCode(stockCode);
            if (!this.queryQueue.has(normalizedCode)) {
                this.queryQueue.set(normalizedCode, []);
            }
            this.queryQueue.get(normalizedCode).push({ resolve, reject });
            this.scheduleBatchProcess();
        });
    }
    normalizeStockCode(code) {
        const trimmed = code.trim();
        if (trimmed.toLowerCase().startsWith('us')) {
            return `us${trimmed.substring(2).toUpperCase()}`;
        }
        if (PATTERNS.FUND_CODE.test(trimmed)) {
            return trimmed.toLowerCase();
        }
        return trimmed.toLowerCase();
    }
    scheduleBatchProcess() {
        if (this.processingTimer) {
            clearTimeout(this.processingTimer);
        }
        this.processingTimer = setTimeout(() => {
            this.processBatch();
        }, CONFIG.BATCH_DELAY);
    }
    async processBatch() {
        const currentQueue = new Map(this.queryQueue);
        this.queryQueue.clear();
        this.processingTimer = null;
        const promises = Array.from(currentQueue.entries()).map(async ([stockCode, callbacks]) => {
            try {
                const cacheKey = `batch_${stockCode}`;
                const cached = batchResultCache.get(cacheKey, CONFIG.BATCH_CACHE_TTL);
                let result;
                if (cached) {
                    result = cached;
                }
                else {
                    result = await this.executeQuery(stockCode);
                    batchResultCache.set(cacheKey, result);
                }
                callbacks.forEach(callback => callback.resolve(result));
            }
            catch (error) {
                callbacks.forEach(callback => callback.reject(error));
            }
        });
        await Promise.all(promises);
    }
    async executeQuery(stockCode) {
        const trimmedCode = stockCode.trim();
        // 6位数字代码：基金优先查询逻辑
        if (PATTERNS.FUND_CODE.test(trimmedCode)) {
            const fundResult = await queryFund(trimmedCode);
            if (fundResult.code === block_basekit_server_api_1.FieldCode.Success && fundResult.hasValidData) {
                return fundResult;
            }
            return await queryStock(trimmedCode);
        }
        // 其他代码直接查询股票
        return await queryStock(trimmedCode);
    }
}
// ==================== 域名配置 ====================
const feishuDm = ['feishu.cn', 'feishucdn.com', 'larksuitecdn.com', 'larksuite.com'];
block_basekit_server_api_1.basekit.addDomainList([...feishuDm, 'qt.gtimg.cn', 'fund.eastmoney.com']);
// ==================== 主要字段配置 ====================
block_basekit_server_api_1.basekit.addField({
    i18n: {
        messages: {
            'zh-CN': {
                'stockCode': '股票/基金代码',
                'stockPrice': '价格/净值',
                'stockName': '名称',
                'queryDate': '查询日期',
                'status': '状态',
                'placeholder': '请输入股票代码（如：sh000001、sz000001、hk00700、usAAPL）或基金代码（如：000311）'
            },
            'en-US': {
                'stockCode': 'Stock/Fund Code',
                'stockPrice': 'Price/NAV',
                'stockName': 'Name',
                'queryDate': 'Query Date',
                'status': 'Status',
                'placeholder': 'Enter stock code (e.g. sh000001, sz000001, hk00700, usAAPL) or fund code (e.g. 000311)'
            },
            'ja-JP': {
                'stockCode': '株式/ファンドコード',
                'stockPrice': '価格/基準価額',
                'stockName': '名称',
                'queryDate': 'クエリ日',
                'status': 'ステータス',
                'placeholder': '株式コード（例：sh000001、sz000001、hk00700、usAAPL）またはファンドコード（例：000311）を入力してください'
            },
        },
    },
    formItems: [
        {
            key: 'stockCode',
            label: t('stockCode'),
            component: block_basekit_server_api_1.FieldComponent.Input,
            props: {
                placeholder: t('placeholder'),
            },
            validator: {
                required: true,
            },
        },
    ],
    resultType: {
        type: block_basekit_server_api_1.FieldType.Object,
        extra: {
            icon: {
                light: 'https://lf3-static.bytednsdoc.com/obj/eden-cn/eqgeh7upeubqnulog/stock-icon.svg',
            },
            properties: [
                {
                    key: 'id',
                    isGroupByKey: true,
                    type: block_basekit_server_api_1.FieldType.Text,
                    label: 'id',
                    hidden: true,
                },
                {
                    key: 'status',
                    type: block_basekit_server_api_1.FieldType.Text,
                    label: t('status'),
                    primary: true,
                },
                {
                    key: 'symbol',
                    type: block_basekit_server_api_1.FieldType.Text,
                    label: t('stockCode'),
                },
                {
                    key: 'name',
                    type: block_basekit_server_api_1.FieldType.Text,
                    label: t('stockName'),
                },
                {
                    key: 'price',
                    type: block_basekit_server_api_1.FieldType.Number,
                    label: t('stockPrice'),
                    extra: {
                        formatter: block_basekit_server_api_1.NumberFormatter.DIGITAL_ROUNDED_2,
                    }
                },
                {
                    key: 'date',
                    type: block_basekit_server_api_1.FieldType.Text,
                    label: t('queryDate'),
                },
            ],
        },
    },
    execute: async (formItemParams, context) => {
        const { stockCode = '' } = formItemParams;
        const queryDate = new Date().toISOString().split('T')[0];
        // 记录性能指标（每100次请求输出一次）
        const metrics = performanceMonitor.getMetrics();
        if (metrics.totalRequests % 100 === 0 && metrics.totalRequests > 0) {
            console.log('Performance Metrics:', {
                totalRequests: metrics.totalRequests,
                successRate: `${((metrics.successfulRequests / metrics.totalRequests) * 100).toFixed(2)}%`,
                averageResponseTime: `${metrics.averageResponseTime.toFixed(2)}ms`,
                cacheHitRate: `${metrics.cacheHitRate.toFixed(2)}%`,
                concurrentRequests: metrics.concurrentRequests,
                queueLength: metrics.queueLength,
                requestCacheStats: requestCache.getStats(),
                batchCacheStats: batchResultCache.getStats()
            });
        }
        const validation = validateStockCode(stockCode);
        if (!validation.isValid) {
            return {
                code: block_basekit_server_api_1.FieldCode.Success,
                data: {
                    id: `error_${Date.now()}`,
                    status: '失败',
                    symbol: stockCode || '无效代码',
                    name: validation.message || '请输入有效的股票或基金代码',
                    price: -1001,
                    date: queryDate
                }
            };
        }
        try {
            const inputCode = stockCode.trim();
            const optimizer = BatchQueryOptimizer.getInstance();
            const result = await optimizer.addQuery(inputCode);
            if (result.code === block_basekit_server_api_1.FieldCode.Success) {
                if (result.data.price <= 0) {
                    result.data.price = CONFIG.PRICE_UNAVAILABLE;
                    result.data.name += '（价格暂不可用）';
                }
                return {
                    code: result.code,
                    data: {
                        ...result.data,
                        status: '成功',
                        date: queryDate
                    }
                };
            }
            else {
                return {
                    code: block_basekit_server_api_1.FieldCode.Success,
                    data: {
                        id: `error_${inputCode}_${Date.now()}`,
                        status: '失败',
                        symbol: inputCode,
                        name: result.message || '查询失败',
                        price: -2002,
                        date: queryDate
                    }
                };
            }
        }
        catch (e) {
            return {
                code: block_basekit_server_api_1.FieldCode.Success,
                data: {
                    id: `exception_${Date.now()}`,
                    status: '失败',
                    symbol: stockCode || '未知代码',
                    name: `系统异常: ${String(e)}`,
                    price: -9999,
                    date: queryDate
                }
            };
        }
    },
});
class PerformanceMonitor {
    constructor() {
        this.metrics = {
            totalRequests: 0,
            successfulRequests: 0,
            failedRequests: 0,
            averageResponseTime: 0,
            cacheHitRate: 0,
            concurrentRequests: 0,
            queueLength: 0,
            lastResetTime: Date.now()
        };
        this.responseTimes = [];
    }
    static getInstance() {
        if (!PerformanceMonitor.instance) {
            PerformanceMonitor.instance = new PerformanceMonitor();
        }
        return PerformanceMonitor.instance;
    }
    recordRequest(startTime, success) {
        const responseTime = Date.now() - startTime;
        this.responseTimes.push(responseTime);
        // 保持最近100个响应时间记录
        if (this.responseTimes.length > 100) {
            this.responseTimes.shift();
        }
        this.metrics.totalRequests++;
        if (success) {
            this.metrics.successfulRequests++;
        }
        else {
            this.metrics.failedRequests++;
        }
        // 计算平均响应时间
        this.metrics.averageResponseTime =
            this.responseTimes.reduce((sum, time) => sum + time, 0) / this.responseTimes.length;
    }
    updateConcurrencyMetrics(activeCount, queueLength) {
        this.metrics.concurrentRequests = activeCount;
        this.metrics.queueLength = queueLength;
    }
    updateCacheMetrics() {
        const requestCacheStats = requestCache.getStats();
        const batchCacheStats = batchResultCache.getStats();
        // 计算综合缓存命中率
        const totalHits = parseFloat(requestCacheStats.hitRate) + parseFloat(batchCacheStats.hitRate);
        this.metrics.cacheHitRate = totalHits / 2;
    }
    getMetrics() {
        this.updateCacheMetrics();
        return { ...this.metrics };
    }
    reset() {
        this.metrics = {
            totalRequests: 0,
            successfulRequests: 0,
            failedRequests: 0,
            averageResponseTime: 0,
            cacheHitRate: 0,
            concurrentRequests: activeRequestCount,
            queueLength: requestQueue.length,
            lastResetTime: Date.now()
        };
        this.responseTimes = [];
    }
}
const performanceMonitor = PerformanceMonitor.getInstance();
exports.default = block_basekit_server_api_1.basekit;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi9zcmMvaW5kZXgudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7QUFBQSxtRkFBNkg7QUFDN0gsTUFBTSxFQUFFLENBQUMsRUFBRSxHQUFHLGdDQUFLLENBQUM7QUFxQnBCLHVEQUF1RDtBQUN2RCxNQUFNLHVCQUF1QjtJQU0zQixZQUFZLFVBQWtCLElBQUk7UUFMMUIsVUFBSyxHQUFHLElBQUksR0FBRyxFQUFnRSxDQUFDO1FBRWhGLGFBQVEsR0FBRyxDQUFDLENBQUM7UUFDYixjQUFTLEdBQUcsQ0FBQyxDQUFDO1FBR3BCLElBQUksQ0FBQyxPQUFPLEdBQUcsT0FBTyxDQUFDO0lBQ3pCLENBQUM7SUFFRCxHQUFHLENBQUMsR0FBVyxFQUFFLEtBQVE7UUFDdkIsSUFBSSxJQUFJLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDO1lBQ3hCLE1BQU0sSUFBSSxHQUFHLElBQUksQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLEdBQUcsQ0FBRSxDQUFDO1lBQ2xDLElBQUksQ0FBQyxLQUFLLEdBQUcsS0FBSyxDQUFDO1lBQ25CLElBQUksQ0FBQyxTQUFTLEdBQUcsSUFBSSxDQUFDLEdBQUcsRUFBRSxDQUFDO1lBQzVCLElBQUksQ0FBQyxXQUFXLEVBQUUsQ0FBQztZQUNuQixJQUFJLENBQUMsS0FBSyxDQUFDLE1BQU0sQ0FBQyxHQUFHLENBQUMsQ0FBQztZQUN2QixJQUFJLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxHQUFHLEVBQUUsSUFBSSxDQUFDLENBQUM7UUFDNUIsQ0FBQzthQUFNLENBQUM7WUFDTixJQUFJLElBQUksQ0FBQyxLQUFLLENBQUMsSUFBSSxJQUFJLElBQUksQ0FBQyxPQUFPLEVBQUUsQ0FBQztnQkFDcEMsTUFBTSxRQUFRLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQyxJQUFJLEVBQUUsQ0FBQyxJQUFJLEVBQUUsQ0FBQyxLQUFL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