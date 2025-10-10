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
// 并发控制函数
async function executeWithConcurrencyControl(task) {
    return new Promise((resolve, reject) => {
        const wrappedTask = async () => {
            try {
                activeRequestCount++;
                const result = await task();
                resolve(result);
            }
            catch (error) {
                reject(error);
            }
            finally {
                activeRequestCount--;
                processQueue();
            }
        };
        if (activeRequestCount < CONFIG.MAX_CONCURRENT_REQUESTS) {
            wrappedTask();
        }
        else {
            requestQueue.push(wrappedTask);
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
                // 使用 Promise.race 实现超时，避免 AbortController 兼容性问题
                const timeoutPromise = new Promise((_, reject) => {
                    setTimeout(() => {
                        reject(new Error(`Request timeout after ${CONFIG.REQUEST_TIMEOUT}ms`));
                    }, CONFIG.REQUEST_TIMEOUT);
                });
                const fetchPromise = fetch(url, options);
                const response = await Promise.race([fetchPromise, timeoutPromise]);
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
    // 如果有前缀 sz、sh、hk、us 就认为是股票
    if (trimmedCode.startsWith('sz') || trimmedCode.startsWith('sh') ||
        trimmedCode.startsWith('hk') || trimmedCode.startsWith('us')) {
        return { isValid: true, type: 'stock' };
    }
    // 如果是纯数字就认为是基金
    if (/^\d+$/.test(trimmedCode)) {
        return { isValid: true, type: 'fund' };
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
// 单位净值强校验函数
function validateNetValue(value) {
    const formatMatch = value.match(/^(\d+\.\d{4})$/);
    if (!formatMatch) {
        return { isValid: false, price: -1 };
    }
    const price = parseFloat(formatMatch[1]);
    if (isNaN(price)) {
        return { isValid: false, price: -1 };
    }
    if (price < CONFIG.PRICE_RANGE.MIN || price > CONFIG.PRICE_RANGE.MAX) {
        return { isValid: false, price: -1 };
    }
    return { isValid: true, price };
}
// 日期格式化函数
function normalizeDate(dateText) {
    const currentYear = new Date().getFullYear();
    if (/^\d{1,2}-\d{1,2}$/.test(dateText)) {
        const [month, day] = dateText.split('-');
        return `${currentYear}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    }
    if (/^\d{1,2}\/\d{1,2}$/.test(dateText)) {
        const [month, day] = dateText.split('/');
        return `${currentYear}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    }
    return extractDateFromContext(dateText);
}
// 基金价格解析 - 优化版本
function parseFundPrice(html) {
    const foundItems = [];
    // 策略1：优先查找表格
    const tableMatches = html.match(/<table[^>]*>[\s\S]*?<\/table>/gi);
    if (tableMatches) {
        for (const table of tableMatches) {
            if (table.includes('单位净值')) {
                const rows = table.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi);
                if (!rows)
                    continue;
                let netValueColumnIndex = -1;
                // 找到"单位净值"列的索引
                for (let i = 0; i < rows.length; i++) {
                    const row = rows[i];
                    if (row.includes('单位净值')) {
                        const cells = row.match(/<t[hd][^>]*>[\s\S]*?<\/t[hd]>/gi);
                        if (cells) {
                            for (let j = 0; j < cells.length; j++) {
                                if (cells[j].includes('单位净值')) {
                                    netValueColumnIndex = j;
                                    break;
                                }
                            }
                        }
                        break;
                    }
                }
                // 解析数据行
                if (netValueColumnIndex !== -1) {
                    for (const row of rows) {
                        if (row.includes('单位净值') || row.includes('<th'))
                            continue;
                        const cells = row.match(/<t[hd][^>]*>[\s\S]*?<\/t[hd]>/gi);
                        if (!cells || cells.length <= netValueColumnIndex)
                            continue;
                        const dateText = cells[0].replace(/<[^>]*>/g, '').trim();
                        const priceText = cells[netValueColumnIndex].replace(/<[^>]*>/g, '').trim();
                        const validation = validateNetValue(priceText);
                        if (validation.isValid) {
                            const normalizedDate = normalizeDate(dateText);
                            if (normalizedDate !== 'NO_DATE_FOUND') {
                                foundItems.push({
                                    date: normalizedDate,
                                    netValue: validation.price,
                                    source: 'table_parsing',
                                    context: ''
                                });
                            }
                        }
                    }
                }
            }
        }
    }
    // 策略2：如果表格没找到数据，使用关键词搜索
    if (foundItems.length === 0) {
        const keyword = '单位净值';
        let searchIndex = 0;
        while (true) {
            const keywordIndex = html.indexOf(keyword, searchIndex);
            if (keywordIndex === -1)
                break;
            const contextStart = Math.max(0, keywordIndex - 200);
            const contextEnd = Math.min(html.length, keywordIndex + 500);
            const context = html.substring(contextStart, contextEnd);
            const priceMatches = context.match(/\d+\.\d{4}/g);
            if (priceMatches) {
                for (const priceText of priceMatches) {
                    const validation = validateNetValue(priceText);
                    if (validation.isValid) {
                        const dateFound = extractDateFromContext(context);
                        if (dateFound !== 'NO_DATE_FOUND') {
                            foundItems.push({
                                date: dateFound,
                                netValue: validation.price,
                                source: 'keyword_search',
                                context: ''
                            });
                        }
                    }
                }
            }
            searchIndex = keywordIndex + 1;
        }
    }
    // 选择最新日期的净值
    if (foundItems.length > 0) {
        foundItems.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
        return foundItems[0].netValue;
    }
    return -1;
}
// 辅助函数：从上下文中提取日期（增强版）
function extractDateFromContext(context) {
    // 添加调试信息
    const debugDateInfo = {
        originalContext: context.substring(0, 200),
        foundDates: []
    };
    // 尝试多种日期格式，按优先级排序
    const datePatterns = [
        { name: 'standard_date', regex: /(\d{4}[-\/]\d{1,2}[-\/]\d{1,2})/g }, // 2024-01-15 或 2024/1/15
        { name: 'chinese_date', regex: /(\d{4}年\d{1,2}月\d{1,2}日)/g }, // 2024年1月15日
        { name: 'net_value_date', regex: /净值日期[^0-9]*(\d{4}[-\/]\d{1,2}[-\/]\d{1,2})/gi }, // 净值日期：2024-01-15
        { name: 'update_time', regex: /更新时间[^0-9]*(\d{4}[-\/]\d{1,2}[-\/]\d{1,2})/gi }, // 更新时间：2024-01-15
        { name: 'date_label', regex: /日期[^0-9]*(\d{4}[-\/]\d{1,2}[-\/]\d{1,2})/gi }, // 日期：2024-01-15
        { name: 'time_label', regex: /时间[^0-9]*(\d{4}[-\/]\d{1,2}[-\/]\d{1,2})/gi }, // 时间：2024-01-15
        { name: 'short_date', regex: /(\d{1,2}[-\/]\d{1,2})/g }, // 01-15 或 1/15 (当年)
        { name: 'timestamp', regex: /(\d{8})/g } // 20241015 格式
    ];
    for (const pattern of datePatterns) {
        let match;
        pattern.regex.lastIndex = 0; // 重置正则表达式状态
        while ((match = pattern.regex.exec(context)) !== null) {
            const dateStr = match[1];
            let normalizedDate = '';
            try {
                if (pattern.name === 'chinese_date') {
                    // 处理中文日期格式
                    normalizedDate = dateStr
                        .replace(/年/g, '-')
                        .replace(/月/g, '-')
                        .replace(/日/g, '');
                }
                else if (pattern.name === 'short_date') {
                    // 处理短日期格式，补充当前年份
                    const currentYear = new Date().getFullYear();
                    normalizedDate = `${currentYear}-${dateStr.replace(/\//g, '-')}`;
                }
                else if (pattern.name === 'timestamp') {
                    // 处理8位时间戳格式 YYYYMMDD
                    if (dateStr.length === 8) {
                        normalizedDate = `${dateStr.substring(0, 4)}-${dateStr.substring(4, 6)}-${dateStr.substring(6, 8)}`;
                    }
                }
                else {
                    // 标准化其他格式
                    normalizedDate = dateStr.replace(/\//g, '-');
                }
                // 验证日期有效性
                const parsedDate = new Date(normalizedDate);
                if (!isNaN(parsedDate.getTime()) && parsedDate.getFullYear() > 2000 && parsedDate.getFullYear() <= new Date().getFullYear() + 1) {
                    debugDateInfo.foundDates.push({
                        pattern: pattern.name,
                        match: dateStr,
                        normalized: normalizedDate
                    });
                    // 输出日期解析调试信息
                    console.log(`日期解析成功: ${pattern.name} -> ${dateStr} -> ${normalizedDate}`);
                    return normalizedDate;
                }
            }
            catch (error) {
                console.log(`日期解析失败: ${pattern.name} -> ${dateStr} -> 错误: ${error}`);
            }
        }
    }
    // 如果没有找到有效日期，不要返回今天的日期，而是返回一个特殊标记
    console.log(`未找到有效日期，上下文: ${context.substring(0, 100)}...`);
    console.log(`日期解析调试信息:`, JSON.stringify(debugDateInfo, null, 2));
    return 'NO_DATE_FOUND';
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
exports.default = block_basekit_server_api_1.basekit;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi9zcmMvaW5kZXgudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7QUFBQSxtRkFBNkg7QUFDN0gsTUFBTSxFQUFFLENBQUMsRUFBRSxHQUFHLGdDQUFLLENBQUM7QUFxQnBCLHVEQUF1RDtBQUN2RCxNQUFNLHVCQUF1QjtJQU0zQixZQUFZLFVBQWtCLElBQUk7UUFMMUIsVUFBSyxHQUFHLElBQUksR0FBRyxFQUFnRSxDQUFDO1FBRWhGLGFBQVEsR0FBRyxDQUFDLENBQUM7UUFDYixjQUFTLEdBQUcsQ0FBQyxDQUFDO1FBR3BCLElBQUksQ0FBQyxPQUFPLEdBQUcsT0FBTyxDQUFDO0lBQ3pCLENBQUM7SUFFRCxHQUFHLENBQUMsR0FBVyxFQUFFLEtBQVE7UUFDdkIsSUFBSSxJQUFJLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDO1lBQ3hCLE1BQU0sSUFBSSxHQUFHLElBQUksQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLEdBQUcsQ0FBRSxDQUFDO1lBQ2xDLElBQUksQ0FBQyxLQUFLLEdBQUcsS0FBSyxDQUFDO1lBQ25CLElBQUksQ0FBQyxTQUFTLEdBQUcsSUFBSSxDQUFDLEdBQUcsRUFBRSxDQUFDO1lBQzVCLElBQUksQ0FBQyxXQUFXLEVBQUUsQ0FBQztZQUNuQixJQUFJLENBQUMsS0FBSyxDQUFDLE1BQU0sQ0FBQyxHQUFHLENBQUMsQ0FBQztZQUN2QixJQUFJLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxHQUFHLEVBQUUsSUFBSSxDQUFDLENBQUM7UUFDNUIsQ0FBQzthQUFNLENBQUM7WUFDTixJQUFJLElBQUksQ0FBQyxLQUFLLENBQUMsSUFBSSxJQUFJLElBQUksQ0FBQyxPQUFPLEVBQUUsQ0FBQztnQkFDcEMsTUFBTSxRQUFRLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQyxJQUFJLEVBQUUsQ0FBQyxJQUFJLEVBQUUsQ0FBQyxLQUFL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