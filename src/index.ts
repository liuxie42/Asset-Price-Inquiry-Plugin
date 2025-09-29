import { basekit, FieldType, field, FieldComponent, FieldCode, NumberFormatter } from '@lark-opdev/block-basekit-server-api';
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

// ==================== 配置常量 ====================
const CONFIG = {
  PRICE_RANGE: { MIN: 0.01, MAX: 10000 },
  REQUEST_TIMEOUT: 10000,
  RETRY_COUNT: 3,
  RETRY_DELAY: 1000,
  PRICE_UNAVAILABLE: null,
  CACHE_TTL: 60000,  // 缓存1分钟
  BATCH_CACHE_TTL: 300000,  // 批量查询缓存5分钟
  MAX_CACHE_SIZE: 1000,     // 最大缓存条目数
  CACHE_CLEANUP_INTERVAL: 300000, // 5分钟清理一次缓存
};

// ==================== 缓存系统 ====================
const requestCache = new Map<string, CacheItem>();
const batchResultCache = new Map<string, CacheItem>();
const pendingRequests = new Map<string, Promise<any>>();

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
function cleanExpiredCache(): void {
  const now = Date.now();
  
  // 清理请求缓存
  for (const [key, value] of requestCache.entries()) {
    if (now - value.timestamp > CONFIG.CACHE_TTL) {
      requestCache.delete(key);
    }
  }
  
  // 清理批量结果缓存
  for (const [key, value] of batchResultCache.entries()) {
    if (now - value.timestamp > CONFIG.BATCH_CACHE_TTL) {
      batchResultCache.delete(key);
    }
  }
  
  // 限制缓存大小
  if (requestCache.size > CONFIG.MAX_CACHE_SIZE) {
    const entries = Array.from(requestCache.entries());
    entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
    const toDelete = entries.slice(0, Math.floor(CONFIG.MAX_CACHE_SIZE * 0.2));
    toDelete.forEach(([key]) => requestCache.delete(key));
  }
}

// 启动定期缓存清理
setInterval(cleanExpiredCache, CONFIG.CACHE_CLEANUP_INTERVAL);

// 网络请求函数 - 带重试机制
async function fetchWithRetry(url: string, options: RequestInit = {}): Promise<Response> {
  let lastError: Error;
  
  for (let attempt = 1; attempt <= CONFIG.RETRY_COUNT; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), CONFIG.REQUEST_TIMEOUT);
      
      const response = await fetch(url, {
        ...options,
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      
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
}

// 请求去重函数
async function fetchWithDeduplication(url: string, options: RequestInit = {}): Promise<string> {
  const cacheKey = `${url}_${JSON.stringify(options)}`;
  
  if (pendingRequests.has(cacheKey)) {
    return await pendingRequests.get(cacheKey)!;
  }
  
  const cached = requestCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp) < CONFIG.CACHE_TTL) {
    return cached.data;
  }
  
  const requestPromise = (async () => {
    try {
      const response = await fetchWithRetry(url, options);
      const text = await response.text();
      
      requestCache.set(cacheKey, {
        data: text,
        timestamp: Date.now()
      });
      
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
function validateStockCode(code: string): { isValid: boolean; type: 'stock' | 'fund' | 'unknown'; message?: string } {
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
function isValidStockName(name: string): boolean {
  if (!name || name.length === 0) return false;
  if (PATTERNS.PURE_NUMBER.test(name)) return false;
  if (name.includes('%')) return false;
  if (PATTERNS.DATE_FORMAT.test(name)) return false;
  if (name.endsWith('OQ') || name.endsWith('oq')) return false;
  
  return true;
}

// ==================== 解析函数 ====================
// 基金名称解析
function parseFundName(html: string, fundCode: string): string {
  const namePatterns = [
    /<title>([^<]+?)(?:\s*\([^)]*\))?\s*(?:基金|净值).*?<\/title>/i,
    /<h1[^>]*>([^<]+?)<\/h1>/i,
  ];

  for (const pattern of namePatterns) {
    const match = html.match(pattern);
    if (match?.[1]) {
      const name = match[1].trim();
      if (name && name !== `基金${fundCode}`) {
        return name;
      }
    }
  }

  return `基金${fundCode}`;
}

// 基金价格解析
function parseFundPrice(html: string): number {
  const pricePatterns = [
    /单位净值[^0-9]*(\d+\.\d{2,4})/i,
    /最新净值[^0-9]*(\d+\.\d{2,4})/i,
    PATTERNS.PRICE_PATTERN
  ];

  for (const pattern of pricePatterns) {
    const matches = html.match(pattern);
    if (matches?.[1]) {
      const price = parseFloat(matches[1]);
      if (!isNaN(price) && price >= CONFIG.PRICE_RANGE.MIN && price <= CONFIG.PRICE_RANGE.MAX) {
        return price;
      }
    }
  }
  
  return -1;
}

// 基金日期解析
function parseFundDate(html: string): string {
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

// 股票名称提取
function extractStockNameFromQtData(dataArr: string[], stockCode: string, debugLog: Function): string {
  if (dataArr.length < 2) {
    debugLog({
      '===数据不足': {
        数组长度: dataArr.length,
        需要最少: 2
      }
    });
    return '';
  }
  
  debugLog({
    '===腾讯API数据解析': {
      总字段数: dataArr.length,
      '索引0_未知': dataArr[0] || 'undefined',
      '索引1_名字': dataArr[1] || 'undefined', 
      '索引2_代码': dataArr[2] || 'undefined',
      '索引3_当前价格': dataArr[3] || 'undefined',
      '索引4_昨收': dataArr[4] || 'undefined',
      '索引5_今开': dataArr[5] || 'undefined',
      '索引6_成交量': dataArr[6] || 'undefined'
    }
  });
  
  const stockName = dataArr[1]?.trim();
  
  if (stockName && stockName.length > 0) {
    let cleanedName = stockName;
    if (cleanedName.endsWith('OQ') || cleanedName.endsWith('oq')) {
      cleanedName = cleanedName.slice(0, -2).trim();
    }
    
    if (isValidStockName(cleanedName)) {
      debugLog({
        '===名称解析成功': {
          原始名称: stockName,
          清理后名称: cleanedName,
          长度: cleanedName.length
        }
      });
      return cleanedName;
    }
  }
  
  debugLog({
    '===名称解析失败': {
      原始名称: stockName,
      原因: '名称为空或格式无效'
    }
  });
  
  return '';
}

// 价格提取
function extractPriceFromQtData(dataArr: string[], debugLog: Function): number {
  if (dataArr.length < 4) {
    debugLog({
      '===价格数据不足': {
        数组长度: dataArr.length,
        需要最少: 4
      }
    });
    return 0;
  }
  
  const priceStr = dataArr[3]?.trim();
  
  if (priceStr) {
    const price = parseFloat(priceStr);
    if (!isNaN(price) && price > 0) {
      debugLog({
        '===价格解析成功': {
          原始价格字符串: priceStr,
          解析后价格: price
        }
      });
      return price;
    }
  }
  
  debugLog({
    '===价格解析失败': {
      原始价格字符串: priceStr,
      原因: '价格为空或无效'
    }
  });
  
  return 0;
}

// 股票数据解析
function parseStockDataFromQtGtimg(responseText: string, stockCode: string, debugLog: Function): {
  name: string;
  price: number;
  success: boolean;
  error?: string;
} {
  try {
    const variableMatch = responseText.match(/v_s_[^=]+="([^"]+)"/);
    
    if (!variableMatch?.[1]) {
      return {
        name: '',
        price: 0,
        success: false,
        error: '数据格式不匹配'
      };
    }

    const dataArr = variableMatch[1].split('~');
    
    if (dataArr.length < 4) {
      return {
        name: '',
        price: 0,
        success: false,
        error: `数据字段不足，仅有${dataArr.length}个字段`
      };
    }

    const stockName = extractStockNameFromQtData(dataArr, stockCode, debugLog);
    const price = extractPriceFromQtData(dataArr, debugLog);
    
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
async function queryFund(fundCode: string, context: any, debugLog: Function): Promise<QueryResult> {
  try {
    debugLog({
      '===开始查询基金': fundCode
    });

    const html = await fetchFundData(fundCode);
    const fundName = parseFundName(html, fundCode);
    const netValue = parseFundPrice(html);
    const valueDate = parseFundDate(html);
    
    debugLog({
      '===基金解析最终结果': {
        name: fundName,
        netValue: netValue,
        date: valueDate
      }
    });

    if (!fundName || fundName.trim() === '') {
      return {
        code: FieldCode.Error,
        message: `基金代码 ${fundCode} 无法解析基金名称`,
        hasValidData: false
      };
    }

    if (netValue === -1) {
      debugLog({
        '===基金净值获取失败，设为-1': fundCode
      });
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
    debugLog({
      '===基金查询异常': String(error)
    });
    return {
      code: FieldCode.Error,
      message: `基金查询异常: ${String(error)}`,
      hasValidData: false
    };
  }
}

// 股票查询
async function queryStock(stockCode: string, context: any, debugLog: Function): Promise<QueryResult> {
  try {
    debugLog({
      '===开始查询股票': stockCode
    });

    const symbol = stockCode;
    let querySymbol = `s_${symbol}`;
    
    if (PATTERNS.FUND_CODE.test(symbol)) {
      querySymbol = `s_sh${symbol}`;
    }
    
    debugLog({
      '===实际查询代码': querySymbol,
      '===原始输入': stockCode
    });
    
    const response = await fetchWithRetry(`https://qt.gtimg.cn/q=${querySymbol}`, {
      headers: {
        'Referer': 'https://finance.qq.com/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    const arrayBuffer = await response.arrayBuffer();
    const decoder = new TextDecoder('gbk');
    const text = decoder.decode(arrayBuffer);
    
    debugLog({
      '===原始API响应': text
    });
    
    if (text.includes('pv_none_match')) {
      if (PATTERNS.FUND_CODE.test(symbol) && querySymbol.includes('sh')) {
        debugLog({
          '===sh前缀失败，尝试sz前缀': symbol
        });
        return queryStock(`sz${symbol}`, context, debugLog);
      }
      
      debugLog({
        '===API返回无匹配': 'pv_none_match'
      });
      return {
        code: FieldCode.Error,
        message: `股票代码 ${stockCode} 无法找到匹配数据，请检查代码格式`
      };
    }

    const parseResult = parseStockDataFromQtGtimg(text, stockCode, debugLog);
    
    if (!parseResult.success) {
      return {
        code: FieldCode.Error,
        message: parseResult.error || '股票数据解析失败'
      };
    }

    const variableMatch = text.match(/v_s_[^=]+="([^"]+)"/);
    const dataArr = variableMatch ? variableMatch[1].split('~') : [];
    const actualTradeDate = getActualTradeDate(dataArr);

    debugLog({
      '===股票解析最终结果': {
        name: parseResult.name,
        price: parseResult.price,
        date: actualTradeDate
      }
    });

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
    debugLog({
      '===股票查询异常': String(error)
    });
    
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

  async addQuery(stockCode: string, context: any, debugLog: Function): Promise<QueryResult> {
    return new Promise((resolve, reject) => {
      const normalizedCode = this.normalizeStockCode(stockCode);
      
      if (!this.queryQueue.has(normalizedCode)) {
        this.queryQueue.set(normalizedCode, []);
      }
      
      this.queryQueue.get(normalizedCode)!.push({ resolve, reject });
      this.scheduleBatchProcess(context, debugLog);
    });
  }

  private normalizeStockCode(code: string): string {
    const trimmed = code.trim();
    
    // 对于US股票，保持原始大小写
    if (trimmed.toLowerCase().startsWith('us')) {
      return `us${trimmed.substring(2).toUpperCase()}`;
    }
    
    // 对于6位数字代码，转换为小写
    if (PATTERNS.FUND_CODE.test(trimmed)) {
      return trimmed.toLowerCase();
    }
    
    // 其他情况转换为小写
    return trimmed.toLowerCase();
  }

  private scheduleBatchProcess(context: any, debugLog: Function): void {
    if (this.processingTimer) {
      clearTimeout(this.processingTimer);
    }
    
    this.processingTimer = setTimeout(() => {
      this.processBatch(context, debugLog);
    }, 50);
  }

  private async processBatch(context: any, debugLog: Function): Promise<void> {
    const currentQueue = new Map(this.queryQueue);
    this.queryQueue.clear();
    this.processingTimer = null;
    
    const promises = Array.from(currentQueue.entries()).map(async ([stockCode, callbacks]) => {
      try {
        const cacheKey = `batch_${stockCode}`;
        const cached = batchResultCache.get(cacheKey);
        
        let result: QueryResult;
        if (cached && (Date.now() - cached.timestamp) < CONFIG.BATCH_CACHE_TTL) {
          result = cached.data;
          cached.hitCount = (cached.hitCount || 0) + 1;
        } else {
          result = await this.executeQuery(stockCode, context, debugLog);
          batchResultCache.set(cacheKey, {
            data: result,
            timestamp: Date.now(),
            hitCount: 1
          });
        }
        
        callbacks.forEach(callback => callback.resolve(result));
      } catch (error) {
        callbacks.forEach(callback => callback.reject(error));
      }
    });
    
    await Promise.all(promises);
    this.cleanExpiredBatchCache();
  }

  private async executeQuery(stockCode: string, context: any, debugLog: Function): Promise<QueryResult> {
    const trimmedCode = stockCode.trim();
    
    debugLog({
      '===批量查询执行': {
        原始代码: stockCode,
        处理后代码: trimmedCode
      }
    });
    
    // 6位数字代码：基金优先查询逻辑
    if (PATTERNS.FUND_CODE.test(trimmedCode)) {
      debugLog({
        '===6位数字代码，优先查询基金': trimmedCode
      });
      
      const fundResult = await queryFund(trimmedCode, context, debugLog);
      
      if (fundResult.code === FieldCode.Success && fundResult.hasValidData) {
        debugLog({
          '===基金查询成功，返回基金数据': trimmedCode
        });
        return fundResult;
      }
      
      debugLog({
        '===基金查询失败或数据无效，尝试股票查询': trimmedCode
      });
      return await queryStock(trimmedCode, context, debugLog);
    }
    
    // 其他代码直接查询股票
    return await queryStock(trimmedCode, context, debugLog);
  }

  private cleanExpiredBatchCache(): void {
    const now = Date.now();
    for (const [key, value] of batchResultCache.entries()) {
      if (now - value.timestamp > CONFIG.BATCH_CACHE_TTL) {
        batchResultCache.delete(key);
      }
    }
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
      component: FieldComponent.Input,
      props: {
        placeholder: t('placeholder'),
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
          label: t('queryDate'),
        },
      ],
    },
  },
  execute: async (formItemParams: { stockCode: string }, context) => {
    const { stockCode = '' } = formItemParams;
    const queryDate = new Date().toISOString().split('T')[0];
    
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
          date: queryDate
        }
      };
    }

    function debugLog(arg: any) {
      console.log(JSON.stringify({
        formItemParams,
        context,
        arg
      }));
    }

    try {
      const inputCode = stockCode.trim();
      const optimizer = BatchQueryOptimizer.getInstance();
      const result = await optimizer.addQuery(inputCode, context, debugLog);
      
      if (result.code === FieldCode.Success) {
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
      } else {
        return {
          code: FieldCode.Success,
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
      
    } catch (e) {
      debugLog({
        '===异常错误': String(e)
      });
      
      return {
        code: FieldCode.Success,
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

export default basekit;