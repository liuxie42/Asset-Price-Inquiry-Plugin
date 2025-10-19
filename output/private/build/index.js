"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.stopCacheCleanup = stopCacheCleanup;
const block_basekit_server_api_1 = require("@lark-opdev/block-basekit-server-api");
// Node.js 14.21.0 兼容性：添加 AbortController polyfill
if (typeof globalThis.AbortController === 'undefined') {
    const { AbortController } = require('node-abort-controller');
    globalThis.AbortController = AbortController;
}
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
// 缓存清理定时器引用
let cacheCleanupTimer = null;
// 清理过期缓存
function cleanExpiredCache() {
    requestCache.cleanup(CONFIG.CACHE_TTL);
    batchResultCache.cleanup(CONFIG.BATCH_CACHE_TTL);
}
// 启动定期缓存清理
function startCacheCleanup() {
    if (!cacheCleanupTimer) {
        cacheCleanupTimer = setInterval(cleanExpiredCache, CONFIG.CACHE_CLEANUP_INTERVAL);
    }
}
// 停止缓存清理
function stopCacheCleanup() {
    if (cacheCleanupTimer) {
        clearInterval(cacheCleanupTimer);
        cacheCleanupTimer = null;
    }
}
// 在模块加载时启动缓存清理
startCacheCleanup();
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
// ==================== 日期验证函数 ====================
/**
 * 验证日期格式和有效性
 * @param dateStr 日期字符串
 * @returns 验证结果和格式化后的日期
 */
function validateQueryDate(dateStr) {
    if (!dateStr || dateStr.trim() === '') {
        return {
            isValid: false,
            formattedDate: '',
            message: '请输入查询日期'
        };
    }
    const trimmedDate = dateStr.trim();
    // 支持多种日期格式：YYYY-MM-DD 或 YYYY/MM/DD
    let normalizedDate = trimmedDate;
    // 将斜杠格式转换为连字符格式
    if (trimmedDate.includes('/')) {
        normalizedDate = trimmedDate.replace(/\//g, '-');
    }
    // 检查基本格式 YYYY-MM-DD
    if (!PATTERNS.DATE_FORMAT.test(normalizedDate)) {
        return {
            isValid: false,
            formattedDate: '',
            message: '请输入正确的日期格式（YYYY-MM-DD 或 YYYY/MM/DD），如：2024-01-15 或 2024/01/15'
        };
    }
    // 验证日期有效性
    const date = new Date(normalizedDate);
    if (isNaN(date.getTime())) {
        return {
            isValid: false,
            formattedDate: '',
            message: '请输入有效的日期'
        };
    }
    // 检查日期范围（不能是未来日期，不能早于2000年）
    const today = new Date();
    const minDate = new Date('2000-01-01');
    if (date > today) {
        return {
            isValid: false,
            formattedDate: '',
            message: '查询日期不能是未来日期'
        };
    }
    if (date < minDate) {
        return {
            isValid: false,
            formattedDate: '',
            message: '查询日期不能早于2000年1月1日'
        };
    }
    return { isValid: true, formattedDate: normalizedDate };
}
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
                'queryDate': '日期',
                'priceDate': '价格日期',
                'status': '状态',
                'placeholder': '请输入股票代码（如：sh000001、sz000001、hk00700、usAAPL）或基金代码（如：000311）',
                'datePlaceholder': '请输入日期（YYYY-MM-DD 或 YYYY/MM/DD），如：2024-01-15（仅用于定时自动化，不代表价格查询日期）'
            },
            'en-US': {
                'stockCode': 'Stock/Fund Code',
                'stockPrice': 'Price/NAV',
                'stockName': 'Name',
                'queryDate': 'Date',
                'priceDate': 'Price Date',
                'status': 'Status',
                'placeholder': 'Enter stock code (e.g. sh000001, sz000001, hk00700, usAAPL) or fund code (e.g. 000311)',
                'datePlaceholder': 'Enter date (YYYY-MM-DD or YYYY/MM/DD), e.g. 2024-01-15 (for automation only, not query date)'
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
        {
            key: 'queryDate',
            label: t('queryDate'),
            component: block_basekit_server_api_1.FieldComponent.Input,
            props: {
                placeholder: t('datePlaceholder'),
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
                    label: t('priceDate'),
                },
            ],
        },
    },
    execute: async (formItemParams, context) => {
        const { stockCode = '', queryDate = '' } = formItemParams;
        // 验证日期输入
        const dateValidation = validateQueryDate(queryDate);
        if (!dateValidation.isValid) {
            return {
                code: block_basekit_server_api_1.FieldCode.Success,
                data: {
                    id: `date_error_${Date.now()}`,
                    status: '失败',
                    symbol: stockCode || '无效代码',
                    name: dateValidation.message || '日期格式错误',
                    price: -1002,
                    date: queryDate || '无效日期'
                }
            };
        }
        const validatedDate = dateValidation.formattedDate;
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
                    date: validatedDate
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
                        status: '成功'
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
                        date: validatedDate
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
                    date: validatedDate
                }
            };
        }
    },
});
exports.default = block_basekit_server_api_1.basekit;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi9zcmMvaW5kZXgudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7QUFtc0NTLDRDQUFnQjtBQW5zQ3pCLG1GQUE2SDtBQUU3SCxrREFBa0Q7QUFDbEQsSUFBSSxPQUFPLFVBQVUsQ0FBQyxlQUFlLEtBQUssV0FBVyxFQUFFLENBQUM7SUFDdEQsTUFBTSxFQUFFLGVBQWUsRUFBRSxHQUFHLE9BQU8sQ0FBQyx1QkFBdUIsQ0FBQyxDQUFDO0lBQzdELFVBQVUsQ0FBQyxlQUFlLEdBQUcsZUFBZSxDQUFDO0FBQy9DLENBQUM7QUFFRCxNQUFNLEVBQUUsQ0FBQyxFQUFFLEdBQUcsZ0NBQUssQ0FBQztBQXFCcEIsdURBQXVEO0FBQ3ZELE1BQU0sdUJBQXVCO0lBTTNCLFlBQVksVUFBa0IsSUFBSTtRQUwxQixVQUFLLEdBQUcsSUFBSSxHQUFHLEVBQWdFLENBQUM7UUFFaEYsYUFBUSxHQUFHLENBQUMsQ0FBQztRQUNiLGNBQVMsR0FBRyxDQUFDLENBQUM7UUFHcEIsSUFBSSxDQUFDLE9BQU8sR0FBRyxPQUFPLENBQUM7SUFDekIsQ0FBQztJQUVELEdBQUcsQ0FBQyxHQUFXLEVBQUUsS0FBUTtRQUN2QixJQUFJLElBQUksQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUM7WUFDeEIsTUFBTSxJQUFJLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsR0FBRyxDQUFFLENBQUM7WUFDbEMsSUFBSSxDQUFDLEtBQUssR0FBRyxLQUFLLENBQUM7WUFDbkIsSUFBSSxDQUFDLFNBQVMsR0FBRyxJQUFJLENBQUMsR0FBRyxFQUFFLENBQUM7WUFDNUIsSUFBSSxDQUFDLFdBQVcsRUFBRSxDQUFDO1lBQ25CLElBQUksQ0FBQyxLQUFLLENBQUMsTUFBTSxDQUFDLEdBQUcsQ0FBQyxDQUFDO1lBQ3ZCLElBQUksQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLEdB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