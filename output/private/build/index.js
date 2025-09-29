"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const block_basekit_server_api_1 = require("@lark-opdev/block-basekit-server-api");
const { t } = block_basekit_server_api_1.field;
// 配置常量
const CONFIG = {
    PRICE_RANGE: { MIN: 0.01, MAX: 10000 },
    REQUEST_TIMEOUT: 10000,
    RETRY_COUNT: 3, // 增加重试次数
    RETRY_DELAY: 1000, // 重试延迟
    PRICE_UNAVAILABLE: null,
    CACHE_TTL: 60000, // 缓存1分钟
};
// 请求缓存
const requestCache = new Map();
// 优化的网络请求函数 - 带重试机制
async function fetchWithRetry(url, options = {}) {
    let lastError;
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
        }
        catch (error) {
            lastError = error;
            if (attempt < CONFIG.RETRY_COUNT) {
                // 指数退避延迟
                const delay = CONFIG.RETRY_DELAY * Math.pow(2, attempt - 1);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }
    throw lastError;
}
// 带缓存的请求函数
async function fetchWithCache(url, options = {}) {
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
    }
    catch (error) {
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
function decodeStockName(arrayBuffer) {
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
    }
    catch (e) {
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
    }
    catch (e) {
        // UTF-8也失败了
    }
    return '';
}
// 优化后的基金数据获取函数
async function fetchFundData(fundCode) {
    return await fetchWithCache(`https://fund.eastmoney.com/${fundCode}.html`, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
    });
}
const feishuDm = ['feishu.cn', 'feishucdn.com', 'larksuitecdn.com', 'larksuite.com'];
block_basekit_server_api_1.basekit.addDomainList([...feishuDm, 'qt.gtimg.cn', 'fund.eastmoney.com']);
// 输入验证函数
function validateStockCode(code) {
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
function parseFundName(html, fundCode) {
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
function parseFundPrice(html) {
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
function parseFundDate(html) {
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
function getActualTradeDate(dataArr) {
    if (dataArr.length > 30 && dataArr[30]) {
        const dateStr = dataArr[30];
        if (/^\d{8}$/.test(dateStr)) {
            return `${dateStr.substring(0, 4)}-${dateStr.substring(4, 6)}-${dateStr.substring(6, 8)}`;
        }
    }
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
block_basekit_server_api_1.basekit.addField({
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
            component: block_basekit_server_api_1.FieldComponent.Input,
            props: {
                placeholder: t('placeholder'),
            },
            validator: {
                required: true,
            }
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
                    type: block_basekit_server_api_1.FieldType.Number, // 恢复为Number类型
                    label: t('stockPrice'),
                    primary: true,
                    extra: {
                        formatter: block_basekit_server_api_1.NumberFormatter.DIGITAL_ROUNDED_2,
                    }
                },
                {
                    key: 'date',
                    type: block_basekit_server_api_1.FieldType.Text,
                    label: t('lastTradeDate'),
                },
            ],
        },
    },
    execute: async (formItemParams, context) => {
        const { stockCode = '' } = formItemParams;
        // 输入验证
        const validation = validateStockCode(stockCode);
        if (!validation.isValid) {
            return {
                code: block_basekit_server_api_1.FieldCode.Success,
                data: {
                    id: `error_${Date.now()}`,
                    symbol: stockCode || '无效代码',
                    name: validation.message || '请输入有效的股票或基金代码',
                    price: -1001, // 输入验证错误编码
                    date: new Date().toISOString().split('T')[0]
                }
            };
        }
        function debugLog(arg) {
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
                if (fundResult.code === block_basekit_server_api_1.FieldCode.Success && fundResult.hasValidData) {
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
                if (fundResult.code === block_basekit_server_api_1.FieldCode.Error) {
                    debugLog({
                        '===基金查询失败，尝试股票查询': fundResult.message || '基金查询失败'
                    });
                }
            }
            const stockResult = await queryStock(inputCode, context, debugLog);
            if (stockResult.code === block_basekit_server_api_1.FieldCode.Success) {
                // 优化价格显示
                if (stockResult.data.price <= 0) {
                    stockResult.data.price = CONFIG.PRICE_UNAVAILABLE;
                    stockResult.data.name += '（价格暂不可用）';
                }
                return {
                    code: stockResult.code,
                    data: stockResult.data
                };
            }
            else {
                let errorMessage = stockResult.message || '查询失败';
                if (isFundCode) {
                    errorMessage = `基金和股票查询均失败。${errorMessage}`;
                }
                // 将错误信息写入name，负数编码写入price
                return {
                    code: block_basekit_server_api_1.FieldCode.Success,
                    data: {
                        id: `error_${inputCode}_${Date.now()}`,
                        symbol: inputCode,
                        name: errorMessage,
                        price: isFundCode ? -2001 : -2002, // -2001: 基金查询失败, -2002: 股票查询失败
                        date: new Date().toISOString().split('T')[0]
                    }
                };
            }
        }
        catch (e) {
            console.log('====error', String(e));
            debugLog({
                '===999 异常错误': String(e)
            });
            // 将异常信息写入name，负数编码写入price
            return {
                code: block_basekit_server_api_1.FieldCode.Success,
                data: {
                    id: `exception_${Date.now()}`,
                    symbol: stockCode || '未知代码',
                    name: `系统异常: ${String(e)}`,
                    price: -9999, // 系统异常编码
                    date: new Date().toISOString().split('T')[0]
                }
            };
        }
    },
});
// 优化后的基金查询函数
async function queryFund(fundCode, context, debugLog) {
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
                code: block_basekit_server_api_1.FieldCode.Error,
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
        debugLog({
            '===基金查询异常': String(error)
        });
        return {
            code: block_basekit_server_api_1.FieldCode.Error,
            message: `基金查询异常: ${String(error)}`,
            hasValidData: false
        };
    }
}
// 优化后的股票查询函数 - 不使用硬编码映射
async function queryStock(stockCode, context, debugLog) {
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
                code: block_basekit_server_api_1.FieldCode.Error,
                message: `股票代码 ${stockCode} 无法解析股票名称`
            };
        }
        // 解析数据
        const decoder = new TextDecoder('gbk');
        const text = decoder.decode(arrayBuffer);
        const dataMatch = text.match(/="([^"]+)"/);
        if (!dataMatch || !dataMatch[1]) {
            return {
                code: block_basekit_server_api_1.FieldCode.Error,
                message: `股票代码 ${stockCode} 数据格式错误`
            };
        }
        const dataArr = dataMatch[1].split('~');
        if (dataArr.length < 4) {
            return {
                code: block_basekit_server_api_1.FieldCode.Error,
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
            code: block_basekit_server_api_1.FieldCode.Success,
            data: {
                id: `stock_${stockCode}_${Date.now()}`,
                symbol: stockCode,
                name: stockName,
                price: price,
                date: actualTradeDate,
            }
        };
    }
    catch (error) {
        debugLog({
            '===股票查询异常': String(error)
        });
        return {
            code: block_basekit_server_api_1.FieldCode.Error,
            message: `股票查询异常: ${String(error)}`
        };
    }
}
exports.default = block_basekit_server_api_1.basekit;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi9zcmMvaW5kZXgudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7QUFBQSxtRkFBNkg7QUFDN0gsTUFBTSxFQUFFLENBQUMsRUFBRSxHQUFHLGdDQUFLLENBQUM7QUFFcEIsT0FBTztBQUNQLE1BQU0sTUFBTSxHQUFHO0lBQ2IsV0FBVyxFQUFFLEVBQUUsR0FBRyxFQUFFLElBQUksRUFBRSxHQUFHLEVBQUUsS0FBSyxFQUFFO0lBQ3RDLGVBQWUsRUFBRSxLQUFLO0lBQ3RCLFdBQVcsRUFBRSxDQUFDLEVBQUcsU0FBUztJQUMxQixXQUFXLEVBQUUsSUFBSSxFQUFHLE9BQU87SUFDM0IsaUJBQWlCLEVBQUUsSUFBSTtJQUN2QixTQUFTLEVBQUUsS0FBSyxFQUFHLFFBQVE7Q0FDNUIsQ0FBQztBQUVGLE9BQU87QUFDUCxNQUFNLFlBQVksR0FBRyxJQUFJLEdBQUcsRUFBNEMsQ0FBQztBQUV6RSxvQkFBb0I7QUFDcEIsS0FBSyxVQUFVLGNBQWMsQ0FBQyxHQUFXLEVBQUUsVUFBdUIsRUFBRTtJQUNsRSxJQUFJLFNBQWdCLENBQUM7SUFFckIsS0FBSyxJQUFJLE9BQU8sR0FBRyxDQUFDLEVBQUUsT0FBTyxJQUFJLE1BQU0sQ0FBQyxXQUFXLEVBQUUsT0FBTyxFQUFFLEVBQUUsQ0FBQztRQUMvRCxJQUFJLENBQUM7WUFDSCxNQUFNLFVBQVUsR0FBRyxJQUFJLGVBQWUsRUFBRSxDQUFDO1lBQ3pDLE1BQU0sU0FBUyxHQUFHLFVBQVUsQ0FBQyxHQUFHLEVBQUUsQ0FBQyxVQUFVLENBQUMsS0FBSyxFQUFFLEVBQUUsTUFBTSxDQUFDLGVBQWUsQ0FBQyxDQUFDO1lBRS9FLE1BQU0sUUFBUSxHQUFHLE1BQU0sS0FBSyxDQUFDLEdBQUcsRUFBRTtnQkFDaEMsR0FBRyxPQUFPO2dCQUNWLE1BQU0sRUFBRSxVQUFVLENBQUMsTUFBTTthQUMxQixDQUFDLENBQUM7WUFFSCxZQUFZLENBQUMsU0FB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