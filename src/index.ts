import { basekit, FieldType, field, FieldComponent, FieldCode, NumberFormatter } from '@lark-opdev/block-basekit-server-api';
const { t } = field;

// 配置常量
const CONFIG = {
  PRICE_RANGE: { MIN: 0.01, MAX: 10000 },
  REQUEST_TIMEOUT: 10000,
  RETRY_COUNT: 3,  // 增加重试次数
  RETRY_DELAY: 1000,  // 重试延迟
  PRICE_UNAVAILABLE: null,
  CACHE_TTL: 60000,  // 缓存1分钟
};

// 请求缓存
const requestCache = new Map<string, { data: any; timestamp: number }>();

// 优化的网络请求函数 - 带重试机制
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
        // 指数退避延迟
        const delay = CONFIG.RETRY_DELAY * Math.pow(2, attempt - 1);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  
  throw lastError!;
}

// 带缓存的请求函数
async function fetchWithCache(url: string, options: RequestInit = {}): Promise<string> {
  const cacheKey = `${url}_${JSON.stringify(options)}`;
  const cached = requestCache.get(cacheKey);
  
  // 检查缓存是否有效
  if (cached && (Date.now() - cached.timestamp) < CONFIG.CACHE_TTL) {
    return cached.data;
  }
  
  try {
    const response = await fetchWithRetry(url, options);
    const text = await response.text();
    
    // 存入缓存
    requestCache.set(cacheKey, {
      data: text,
      timestamp: Date.now()
    });
    
    // 清理过期缓存
    cleanExpiredCache();
    
    return text;
  } catch (error) {
    throw new Error(`网络请求失败: ${error.message}`);
  }
}

// 清理过期缓存
function cleanExpiredCache() {
  const now = Date.now();
  for (const [key, value] of requestCache.entries()) {
    if (now - value.timestamp > CONFIG.CACHE_TTL) {
      requestCache.delete(key);
    }
  }
}

// 简化的编码处理函数
function decodeStockName(arrayBuffer: ArrayBuffer): string {
  // 优先尝试GBK编码，这是腾讯API的默认编码
  try {
    const decoder = new TextDecoder('gbk');
    const text = decoder.decode(arrayBuffer);
    
    const dataMatch = text.match(/="([^"]+)"/);
    if (dataMatch && dataMatch[1]) {
      const dataArr = dataMatch[1].split('~');
      const name = dataArr[1] || '';
      
      // 简单验证：检查是否包含乱码
      if (name && !name.includes('�') && !name.includes('锟斤拷')) {
        return name;
      }
    }
  } catch (e) {
    // GBK解码失败，尝试UTF-8
  }
  
  // 备用方案：UTF-8编码
  try {
    const decoder = new TextDecoder('utf-8');
    const text = decoder.decode(arrayBuffer);
    
    const dataMatch = text.match(/="([^"]+)"/);
    if (dataMatch && dataMatch[1]) {
      const dataArr = dataMatch[1].split('~');
      return dataArr[1] || '';
    }
  } catch (e) {
    // UTF-8也失败了
  }
  
  return '';
}

// 优化后的基金数据获取函数
async function fetchFundData(fundCode: string): Promise<string> {
  return await fetchWithCache(`https://fund.eastmoney.com/${fundCode}.html`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
    }
  });
}

const feishuDm = ['feishu.cn', 'feishucdn.com', 'larksuitecdn.com', 'larksuite.com'];
basekit.addDomainList([...feishuDm, 'qt.gtimg.cn', 'fund.eastmoney.com']);

// 输入验证函数
function validateStockCode(code: string): { isValid: boolean; type: 'stock' | 'fund' | 'unknown'; message?: string } {
  const trimmedCode = code.trim().toLowerCase();
  
  if (!trimmedCode) {
    return {
      isValid: false,
      type: 'unknown',
      message: '请输入有效的股票代码（如：sh000001、sz000001、hk00700、usAAPL）或基金代码（如：000311）'
    };
  }
  
  // 基金代码：6位数字
  if (/^\d{6}$/.test(trimmedCode)) {
    return { isValid: true, type: 'fund' };
  }
  
  // 股票代码：各种格式
  if (/^(sh|sz|hk|us)[a-z0-9]+$/i.test(trimmedCode) || /^\d{6}$/.test(trimmedCode)) {
    return { isValid: true, type: 'stock' };
  }
  
  return {
    isValid: false,
    type: 'unknown',
    message: '请输入有效的股票代码（如：sh000001、sz000001、hk00700、usAAPL）或基金代码（如：000311）'
  };
}

// 基金名称解析函数
function parseFundName(html: string, fundCode: string): string {
  const namePatterns = [
    /<title>([^<]+?)(?:\s*\([^)]*\))?\s*(?:基金|净值).*?<\/title>/i,
    /<h1[^>]*>([^<]+?)<\/h1>/i,
  ];

  for (const pattern of namePatterns) {
    const match = html.match(pattern);
    if (match && match[1]) {
      const name = match[1].trim();
      if (name && name !== `基金${fundCode}`) {
        return name;
      }
    }
  }

  return `基金${fundCode}`;
}

// 基金价格解析函数
function parseFundPrice(html: string): number {
  const pricePatterns = [
    /单位净值[^0-9]*(\d+\.\d{2,4})/i,
    /最新净值[^0-9]*(\d+\.\d{2,4})/i,
    /(\d+\.\d{4})/g
  ];

  for (const pattern of pricePatterns) {
    const matches = html.match(pattern);
    if (matches) {
      const price = parseFloat(matches[1]);
      if (!isNaN(price) && price >= CONFIG.PRICE_RANGE.MIN && price <= CONFIG.PRICE_RANGE.MAX) {
        return price;
      }
    }
  }
  
  return -1;
}

// 基金日期解析函数
function parseFundDate(html: string): string {
  const datePatterns = [
    /(\d{4}[-\/]\d{1,2}[-\/]\d{1,2})/g,
    /(\d{4}年\d{1,2}月\d{1,2}日)/g,
    /更新时间[^0-9]*(\d{4}[-\/]\d{1,2}[-\/]\d{1,2})/gi,
    /净值日期[^0-9]*(\d{4}[-\/]\d{1,2}[-\/]\d{1,2})/gi
  ];

  for (const pattern of datePatterns) {
    const dateMatch = html.match(pattern);
    if (dateMatch && dateMatch[1]) {
      return dateMatch[1].replace(/年|月/g, '-').replace(/日/g, '').replace(/\//g, '-');
    }
  }
  
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

// 股票交易日期获取函数
function getActualTradeDate(dataArr: string[]): string {
  if (dataArr.length > 30 && dataArr[30]) {
    const dateStr = dataArr[30];
    if (/^\d{8}$/.test(dateStr)) {
      return `${dateStr.substring(0,4)}-${dateStr.substring(4,6)}-${dateStr.substring(6,8)}`;
    }
  }
  
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

basekit.addField({
  i18n: {
    messages: {
      'zh-CN': {
        'stockCode': '股票/基金代码',
        'stockPrice': '价格/净值',
        'stockName': '名称',
        'lastTradeDate': '交易日期',
        'placeholder': '请输入股票代码（如：sh000001、sz000001、hk00700、usAAPL）或基金代码（如：000311）'
      },
      'en-US': {
        'stockCode': 'Stock/Fund Code',
        'stockPrice': 'Price/NAV',
        'stockName': 'Name',
        'lastTradeDate': 'Trade Date',
        'placeholder': 'Enter stock code (e.g. sh000001, sz000001, hk00700, usAAPL) or fund code (e.g. 000311)'
      },
      'ja-JP': {
        'stockCode': '株式/ファンドコード',
        'stockPrice': '価格/基準価額',
        'stockName': '名称',
        'lastTradeDate': '取引日',
        'placeholder': '株式コード（例：sh000001、sz000001、hk00700、usAAPL）またはファンドコード（例：000311）を入力してください'
      },
    }
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
      }
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
          type: FieldType.Number,  // 恢复为Number类型
          label: t('stockPrice'),
          primary: true,
          extra: {
            formatter: NumberFormatter.DIGITAL_ROUNDED_2,
          }
        },
        {
          key: 'date',
          type: FieldType.Text,
          label: t('lastTradeDate'),
        },
      ],
    },
  },
  execute: async (formItemParams: { stockCode: string }, context) => {
    const { stockCode = '' } = formItemParams;
    
    // 输入验证
    const validation = validateStockCode(stockCode);
    if (!validation.isValid) {
      return {
        code: FieldCode.Success,
        data: {
          id: `error_${Date.now()}`,
          symbol: stockCode || '无效代码',
          name: validation.message || '请输入有效的股票或基金代码',
          price: -1001,  // 输入验证错误编码
          date: new Date().toISOString().split('T')[0]
        }
      };
    }

    function debugLog(arg: any) {
      // @ts-ignore
      console.log(JSON.stringify({
        formItemParams,
        context,
        arg
      }));
    }

    try {
      const inputCode = stockCode.trim();
      const isFundCode = /^\d{6}$/.test(inputCode);
      
      if (isFundCode) {
        const fundResult = await queryFund(inputCode, context, debugLog);
        
        if (fundResult.code === FieldCode.Success && fundResult.hasValidData) {
          // 优化价格显示
          if (fundResult.data.price <= 0) {
            fundResult.data.price = CONFIG.PRICE_UNAVAILABLE;
            fundResult.data.name += '（价格暂不可用）';
          }
          return {
            code: fundResult.code,
            data: fundResult.data
          };
        }
        
        if (fundResult.code === FieldCode.Error) {
          debugLog({
            '===基金查询失败，尝试股票查询': fundResult.message || '基金查询失败'
          });
        }
      }
      
      const stockResult = await queryStock(inputCode, context, debugLog);
      
      if (stockResult.code === FieldCode.Success) {
        // 优化价格显示
        if (stockResult.data.price <= 0) {
          stockResult.data.price = CONFIG.PRICE_UNAVAILABLE;
          stockResult.data.name += '（价格暂不可用）';
        }
        return {
          code: stockResult.code,
          data: stockResult.data
        };
      } else {
        let errorMessage = (stockResult as any).message || '查询失败';
        
        if (isFundCode) {
          errorMessage = `基金和股票查询均失败。${errorMessage}`;
        }
        
        // 将错误信息写入name，负数编码写入price
        return {
          code: FieldCode.Success,
          data: {
            id: `error_${inputCode}_${Date.now()}`,
            symbol: inputCode,
            name: errorMessage,
            price: isFundCode ? -2001 : -2002,  // -2001: 基金查询失败, -2002: 股票查询失败
            date: new Date().toISOString().split('T')[0]
          }
        };
      }
      
    } catch (e) {
      console.log('====error', String(e));
      debugLog({
        '===999 异常错误': String(e)
      });
      
      // 将异常信息写入name，负数编码写入price
      return {
        code: FieldCode.Success,
        data: {
          id: `exception_${Date.now()}`,
          symbol: stockCode || '未知代码',
          name: `系统异常: ${String(e)}`,
          price: -9999,  // 系统异常编码
          date: new Date().toISOString().split('T')[0]
        }
      };
    }
  },
});

// 优化后的基金查询函数
async function queryFund(fundCode: string, context: any, debugLog: Function): Promise<{
  code: FieldCode;
  data?: any;
  message?: string;
  hasValidData: boolean;
}> {
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

// 优化后的股票查询函数 - 不使用硬编码映射
async function queryStock(stockCode: string, context: any, debugLog: Function): Promise<{
  code: FieldCode;
  data?: any;
  message?: string;
}> {
  try {
    debugLog({
      '===开始查询股票': stockCode
    });

    const symbol = stockCode.toLowerCase();
    
    // 使用优化的网络请求
    const response = await fetchWithRetry(`https://qt.gtimg.cn/q=${symbol}`, {
      headers: {
        'Referer': 'https://finance.qq.com/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    const arrayBuffer = await response.arrayBuffer();
    
    // 使用简化的编码处理
    const stockName = decodeStockName(arrayBuffer);
    
    if (!stockName) {
      return {
        code: FieldCode.Error,
        message: `股票代码 ${stockCode} 无法解析股票名称`
      };
    }

    // 解析数据
    const decoder = new TextDecoder('gbk');
    const text = decoder.decode(arrayBuffer);
    const dataMatch = text.match(/="([^"]+)"/);
    
    if (!dataMatch || !dataMatch[1]) {
      return {
        code: FieldCode.Error,
        message: `股票代码 ${stockCode} 数据格式错误`
      };
    }

    const dataArr = dataMatch[1].split('~');
    
    if (dataArr.length < 4) {
      return {
        code: FieldCode.Error,
        message: `股票代码 ${stockCode} 数据不完整`
      };
    }

    const price = parseFloat(dataArr[3]) || -1;
    const actualTradeDate = getActualTradeDate(dataArr);

    debugLog({
      '===股票解析最终结果': {
        name: stockName,
        price: price,
        date: actualTradeDate
      }
    });

    return {
      code: FieldCode.Success,
      data: {
        id: `stock_${stockCode}_${Date.now()}`,
        symbol: stockCode,
        name: stockName,
        price: price,
        date: actualTradeDate,
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

export default basekit;