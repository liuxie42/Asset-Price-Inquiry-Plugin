import { basekit, FieldType, field, FieldComponent, FieldCode, NumberFormatter } from '@lark-opdev/block-basekit-server-api';

// Node.js 14.21.0 兼容性：添加 AbortController polyfill
if (typeof globalThis.AbortController === 'undefined') {
  const { AbortController } = require('node-abort-controller');
  globalThis.AbortController = AbortController;
}

const { t } = field;

// ==================== 类型定义 ====================
interface QueryResult {
  code: FieldCode;
  data?: any;
  message?: string;
  hasValidData?: boolean;
}

interface QueueItem {
  resolve: (value: QueryResult) => void;
  reject: (reason: any) => void;
}

interface CacheItem {
  data: any;
  timestamp: number;
  hitCount?: number;
}

// ==================== 高性能LRU缓存实现 ====================
class HighPerformanceLRUCache<T> {
  private cache = new Map<string, { value: T; timestamp: number; accessCount: number }>();
  private maxSize: number;
  private hitCount = 0;
  private missCount = 0;

  constructor(maxSize: number = 1000) {
    this.maxSize = maxSize;
  }

  set(key: string, value: T): void {
    if (this.cache.has(key)) {
      const item = this.cache.get(key)!;
      item.value = value;
      item.timestamp = Date.now();
      item.accessCount++;
      this.cache.delete(key);
      this.cache.set(key, item);
    } else {
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

  get(key: string, ttl: number): T | null {
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

  clear(): void {
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
  cleanup(ttl: number): void {
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
const requestCache = new HighPerformanceLRUCache<any>(CONFIG.MAX_CACHE_SIZE);
const batchResultCache = new HighPerformanceLRUCache<any>(CONFIG.MAX_CACHE_SIZE);
const pendingRequests = new Map<string, Promise<any>>();

// 请求去重和并发控制
let activeRequestCount = 0;
const requestQueue: Array<() => Promise<any>> = [];

// 并发控制函数
async function executeWithConcurrencyControl<T>(task: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const wrappedTask = async () => {
      try {
        activeRequestCount++;
        
        const result = await task();
        resolve(result);
      } catch (error) {
        reject(error);
      } finally {
        activeRequestCount--;
        processQueue();
      }
    };

    if (activeRequestCount < CONFIG.MAX_CONCURRENT_REQUESTS) {
      wrappedTask();
    } else {
      requestQueue.push(wrappedTask);
    }
  });
}

// 处理队列中的请求
function processQueue(): void {
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
let cacheCleanupTimer: NodeJS.Timeout | null = null;

// 清理过期缓存
function cleanExpiredCache(): void {
  requestCache.cleanup(CONFIG.CACHE_TTL);
  batchResultCache.cleanup(CONFIG.BATCH_CACHE_TTL);
}

// 启动定期缓存清理
function startCacheCleanup(): void {
  if (!cacheCleanupTimer) {
    cacheCleanupTimer = setInterval(cleanExpiredCache, CONFIG.CACHE_CLEANUP_INTERVAL);
  }
}

// 停止缓存清理
function stopCacheCleanup(): void {
  if (cacheCleanupTimer) {
    clearInterval(cacheCleanupTimer);
    cacheCleanupTimer = null;
  }
}

// 在模块加载时启动缓存清理
startCacheCleanup();

// 网络请求函数 - 带重试机制和并发控制
async function fetchWithRetry(url: string, options: RequestInit = {}): Promise<Response> {
  return executeWithConcurrencyControl(async () => {
    let lastError: Error;
    
    for (let attempt = 1; attempt <= CONFIG.RETRY_COUNT; attempt++) {
      try {
        // 使用 Promise.race 实现超时，避免 AbortController 兼容性问题
        const timeoutPromise = new Promise<never>((_, reject) => {
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
        
      } catch (error) {
        lastError = error as Error;
        
        if (attempt < CONFIG.RETRY_COUNT) {
          const delay = CONFIG.RETRY_DELAY * Math.pow(2, attempt - 1);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }
    
    throw lastError!;
  });
}

// 请求去重函数
async function fetchWithDeduplication(url: string, options: RequestInit = {}): Promise<string> {
  const cacheKey = `${url}_${JSON.stringify(options)}`;
  
  if (pendingRequests.has(cacheKey)) {
    return await pendingRequests.get(cacheKey)!;
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
    } finally {
      pendingRequests.delete(cacheKey);
    }
  })();
  
  pendingRequests.set(cacheKey, requestPromise);
  return await requestPromise;
}

// 基金数据获取函数
async function fetchFundData(fundCode: string): Promise<string> {
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
function validateQueryDate(dateStr: string): { isValid: boolean; formattedDate: string; message?: string } {
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

function validateStockCode(code: string): { isValid: boolean; type: 'stock' | 'fund' | 'unknown'; message?: string } {
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
function isValidStockName(name: string): boolean {
  if (!name || name.length === 0) return false;
  if (PATTERNS.PURE_NUMBER.test(name)) return false;
  if (name.includes('%')) return false;
  if (PATTERNS.DATE_FORMAT.test(name)) return false;
  if (name.endsWith('OQ') || name.endsWith('oq')) return false;
  
  return true;
}

// ==================== 解析函数 ====================
// 基金名称解析 - 优化版本
function parseFundName(html: string, fundCode: string): string {
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

// 定义基金净值数据接口
interface FundNetValueData {
  date: string;
  netValue: number;
  source: string;
  context: string;
}



// 单位净值强校验函数
function validateNetValue(value: string): { isValid: boolean; price: number } {
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
function normalizeDate(dateText: string): string {
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
function parseFundPrice(html: string): number {
  const foundItems: FundNetValueData[] = [];
  
  // 策略1：优先查找表格
  const tableMatches = html.match(/<table[^>]*>[\s\S]*?<\/table>/gi);
  if (tableMatches) {
    for (const table of tableMatches) {
      if (table.includes('单位净值')) {
        const rows = table.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi);
        if (!rows) continue;
        
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
            if (row.includes('单位净值') || row.includes('<th')) continue;
            
            const cells = row.match(/<t[hd][^>]*>[\s\S]*?<\/t[hd]>/gi);
            if (!cells || cells.length <= netValueColumnIndex) continue;
            
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
      if (keywordIndex === -1) break;
      
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
function extractDateFromContext(context: string): string {
  // 添加调试信息
  const debugDateInfo = {
    originalContext: context.substring(0, 200),
    foundDates: [] as Array<{pattern: string, match: string, normalized: string}>
  };

  // 尝试多种日期格式，按优先级排序
  const datePatterns = [
    { name: 'standard_date', regex: /(\d{4}[-\/]\d{1,2}[-\/]\d{1,2})/g },           // 2024-01-15 或 2024/1/15
    { name: 'chinese_date', regex: /(\d{4}年\d{1,2}月\d{1,2}日)/g },              // 2024年1月15日
    { name: 'net_value_date', regex: /净值日期[^0-9]*(\d{4}[-\/]\d{1,2}[-\/]\d{1,2})/gi },  // 净值日期：2024-01-15
    { name: 'update_time', regex: /更新时间[^0-9]*(\d{4}[-\/]\d{1,2}[-\/]\d{1,2})/gi },   // 更新时间：2024-01-15
    { name: 'date_label', regex: /日期[^0-9]*(\d{4}[-\/]\d{1,2}[-\/]\d{1,2})/gi },        // 日期：2024-01-15
    { name: 'time_label', regex: /时间[^0-9]*(\d{4}[-\/]\d{1,2}[-\/]\d{1,2})/gi },        // 时间：2024-01-15
    { name: 'short_date', regex: /(\d{1,2}[-\/]\d{1,2})/g },                      // 01-15 或 1/15 (当年)
    { name: 'timestamp', regex: /(\d{8})/g }                                      // 20241015 格式
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
        } else if (pattern.name === 'short_date') {
          // 处理短日期格式，补充当前年份
          const currentYear = new Date().getFullYear();
          normalizedDate = `${currentYear}-${dateStr.replace(/\//g, '-')}`;
        } else if (pattern.name === 'timestamp') {
          // 处理8位时间戳格式 YYYYMMDD
          if (dateStr.length === 8) {
            normalizedDate = `${dateStr.substring(0,4)}-${dateStr.substring(4,6)}-${dateStr.substring(6,8)}`;
          }
        } else {
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
      } catch (error) {
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
function parseFundDate(html: string): string {
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
function getActualTradeDate(dataArr: string[]): string {
  if (dataArr.length > 30 && dataArr[30] && /^\d{8}$/.test(dataArr[30])) {
    const dateStr = dataArr[30];
    return `${dateStr.substring(0,4)}-${dateStr.substring(4,6)}-${dateStr.substring(6,8)}`;
  }
  
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

// 股票名称提取 - 优化版本
function extractStockNameFromQtData(dataArr: string[]): string {
  if (dataArr.length < 2) return '';
  
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
function extractPriceFromQtData(dataArr: string[]): number {
  if (dataArr.length < 4) return 0;
  
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
function parseStockDataFromQtGtimg(responseText: string): {
  name: string;
  price: number;
  success: boolean;
  error?: string;
} {
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

  } catch (error) {
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
async function queryFund(fundCode: string): Promise<QueryResult> {
  try {
    const html = await fetchFundData(fundCode);
    const fundName = parseFundName(html, fundCode);
    const netValue = parseFundPrice(html);
    const valueDate = parseFundDate(html);

    if (!fundName || fundName.trim() === '') {
      return {
        code: FieldCode.Error,
        message: `基金代码 ${fundCode} 无法解析基金名称`,
        hasValidData: false
      };
    }

    if (netValue === -1) {
      // 基金净值获取失败，设为-1
    }

    const hasValidData = fundName && fundName !== `基金${fundCode}` && netValue > 0;

    return {
      code: FieldCode.Success,
      data: {
        id: `fund_${fundCode}_${Date.now()}`,
        symbol: fundCode,
        name: fundName,
        price: netValue,
        date: valueDate,
      },
      hasValidData: hasValidData
    };

  } catch (error) {
    return {
      code: FieldCode.Error,
      message: `基金查询异常: ${String(error)}`,
      hasValidData: false
    };
  }
}

// 股票查询
async function queryStock(stockCode: string): Promise<QueryResult> {
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
        code: FieldCode.Error,
        message: `股票代码 ${stockCode} 无法找到匹配数据，请检查代码格式`
      };
    }

    const parseResult = parseStockDataFromQtGtimg(text);
    
    if (!parseResult.success) {
      return {
        code: FieldCode.Error,
        message: parseResult.error || '股票数据解析失败'
      };
    }

    const variableMatch = text.match(/v_s_[^=]+="([^"]+)"/);
    const dataArr = variableMatch ? variableMatch[1].split('~') : [];
    const actualTradeDate = getActualTradeDate(dataArr);

    return {
      code: FieldCode.Success,
      data: {
        id: `stock_${stockCode}_${Date.now()}`,
        symbol: stockCode,
        name: parseResult.name,
        price: parseResult.price,
        date: actualTradeDate,
        status: '查询成功'
      }
    };

  } catch (error) {
    return {
      code: FieldCode.Error,
      message: `股票查询异常: ${String(error)}`
    };
  }
}

// ==================== 批量查询优化器 ====================
class BatchQueryOptimizer {
  private static instance: BatchQueryOptimizer;
  private queryQueue: Map<string, QueueItem[]> = new Map();
  private processingTimer: NodeJS.Timeout | null = null;

  static getInstance(): BatchQueryOptimizer {
    if (!BatchQueryOptimizer.instance) {
      BatchQueryOptimizer.instance = new BatchQueryOptimizer();
    }
    return BatchQueryOptimizer.instance;
  }

  async addQuery(stockCode: string): Promise<QueryResult> {
    return new Promise((resolve, reject) => {
      const normalizedCode = this.normalizeStockCode(stockCode);
      
      if (!this.queryQueue.has(normalizedCode)) {
        this.queryQueue.set(normalizedCode, []);
      }
      
      this.queryQueue.get(normalizedCode)!.push({ resolve, reject });
      this.scheduleBatchProcess();
    });
  }

  private normalizeStockCode(code: string): string {
    const trimmed = code.trim();
    
    if (trimmed.toLowerCase().startsWith('us')) {
      return `us${trimmed.substring(2).toUpperCase()}`;
    }
    
    if (PATTERNS.FUND_CODE.test(trimmed)) {
      return trimmed.toLowerCase();
    }
    
    return trimmed.toLowerCase();
  }

  private scheduleBatchProcess(): void {
    if (this.processingTimer) {
      clearTimeout(this.processingTimer);
    }
    
    this.processingTimer = setTimeout(() => {
      this.processBatch();
    }, CONFIG.BATCH_DELAY);
  }

  private async processBatch(): Promise<void> {
    const currentQueue = new Map(this.queryQueue);
    this.queryQueue.clear();
    this.processingTimer = null;
    
    const promises = Array.from(currentQueue.entries()).map(async ([stockCode, callbacks]) => {
      try {
        const cacheKey = `batch_${stockCode}`;
        const cached = batchResultCache.get(cacheKey, CONFIG.BATCH_CACHE_TTL);
        
        let result: QueryResult;
        if (cached) {
          result = cached;
        } else {
          result = await this.executeQuery(stockCode);
          batchResultCache.set(cacheKey, result);
        }
        
        callbacks.forEach(callback => callback.resolve(result));
      } catch (error) {
        callbacks.forEach(callback => callback.reject(error));
      }
    });
    
    await Promise.all(promises);
  }

  private async executeQuery(stockCode: string): Promise<QueryResult> {
    const trimmedCode = stockCode.trim();
    
    // 6位数字代码：基金优先查询逻辑
    if (PATTERNS.FUND_CODE.test(trimmedCode)) {
      const fundResult = await queryFund(trimmedCode);
      
      if (fundResult.code === FieldCode.Success && fundResult.hasValidData) {
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
basekit.addDomainList([...feishuDm, 'qt.gtimg.cn', 'fund.eastmoney.com']);

// ==================== 主要字段配置 ====================
basekit.addField({
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
      component: FieldComponent.Input,
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
      component: FieldComponent.Input,
      props: {
        placeholder: t('datePlaceholder'),
      },
      validator: {
        required: true,
      },
    },
  ],
  resultType: {
    type: FieldType.Object,
    extra: {
      icon: {
        light: 'https://lf3-static.bytednsdoc.com/obj/eden-cn/eqgeh7upeubqnulog/stock-icon.svg',
      },
      properties: [
        {
          key: 'id',
          isGroupByKey: true,
          type: FieldType.Text,
          label: 'id',
          hidden: true,
        },
        {
          key: 'status',
          type: FieldType.Text,
          label: t('status'),
          primary: true,
        },
        {
          key: 'symbol',
          type: FieldType.Text,
          label: t('stockCode'),
        },
        {
          key: 'name',
          type: FieldType.Text,
          label: t('stockName'),
        },
        {
          key: 'price',
          type: FieldType.Number,
          label: t('stockPrice'),
          extra: {
            formatter: NumberFormatter.DIGITAL_ROUNDED_2,
          }
        },
        {
          key: 'date',
          type: FieldType.Text,
          label: t('priceDate'),
        },
      ],
    },
  },
  execute: async (formItemParams: { stockCode: string; queryDate?: string }, context) => {
    const { stockCode = '', queryDate = '' } = formItemParams;
    
    // 验证日期输入
    const dateValidation = validateQueryDate(queryDate);
    if (!dateValidation.isValid) {
      return {
        code: FieldCode.Success,
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
        code: FieldCode.Success,
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
      
      if (result.code === FieldCode.Success) {
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
      } else {
        return {
          code: FieldCode.Success,
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
      
    } catch (e) {
      return {
        code: FieldCode.Success,
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



export default basekit;

// 导出清理函数供测试使用
export { stopCacheCleanup };