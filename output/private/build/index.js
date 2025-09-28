"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const block_basekit_server_api_1 = require("@lark-opdev/block-basekit-server-api");
const { t } = block_basekit_server_api_1.field;
const feishuDm = ['feishu.cn', 'feishucdn.com', 'larksuitecdn.com', 'larksuite.com'];
// 通过addDomainList添加请求接口的域名，支持股票和基金查询
block_basekit_server_api_1.basekit.addDomainList([...feishuDm, 'qt.gtimg.cn', 'fund.eastmoney.com']);
block_basekit_server_api_1.basekit.addField({
    // 定义捷径的i18n语言资源
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
    // 定义捷径的入参
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
    // 定义捷径的返回结果类型
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
                    type: block_basekit_server_api_1.FieldType.Number,
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
    // formItemParams 为运行时传入的字段参数，对应字段配置里的 formItems （如引用的依赖字段）
    execute: async (formItemParams, context) => {
        const { stockCode = '' } = formItemParams;
        // 为空或者不是有效的代码格式时返回错误
        if (!stockCode || !stockCode.trim()) {
            return {
                code: block_basekit_server_api_1.FieldCode.Error,
                message: '请输入有效的股票或基金代码'
            };
        }
        /** 为方便查看日志，使用此方法替代console.log */
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
            // 判断是基金代码还是股票代码
            // 优先尝试基金查询，如果失败再尝试股票查询
            const isFundCode = /^\d{6}$/.test(inputCode);
            if (isFundCode) {
                // 先尝试基金查询
                const fundResult = await queryFund(inputCode, context, debugLog);
                // 如果基金查询成功且有有效数据，返回结果
                if (fundResult.code === block_basekit_server_api_1.FieldCode.Success && fundResult.hasValidData) {
                    return {
                        code: fundResult.code,
                        data: fundResult.data
                    };
                }
                // 如果基金查询失败，记录错误并尝试股票查询
                if (fundResult.code === block_basekit_server_api_1.FieldCode.Error) {
                    debugLog({
                        '===基金查询失败，尝试股票查询': fundResult.message || '基金查询失败'
                    });
                }
            }
            // 基金查询失败或不是基金代码，尝试股票查询
            const stockResult = await queryStock(inputCode, context, debugLog);
            if (stockResult.code === block_basekit_server_api_1.FieldCode.Success) {
                return {
                    code: stockResult.code,
                    data: stockResult.data
                };
            }
            else {
                // 如果股票查询也失败，返回更详细的错误信息
                let errorMessage = stockResult.message || '查询失败';
                // 如果之前基金查询也失败了，合并错误信息
                if (isFundCode) {
                    errorMessage = `基金和股票查询均失败。${errorMessage}`;
                }
                return {
                    code: block_basekit_server_api_1.FieldCode.Error,
                    message: errorMessage
                };
            }
        }
        catch (e) {
            console.log('====error', String(e));
            debugLog({
                '===999 异常错误': String(e)
            });
            return {
                code: block_basekit_server_api_1.FieldCode.Error,
                message: `系统异常: ${String(e)}`
            };
        }
    },
});
// 基金查询函数
async function queryFund(fundCode, context, debugLog) {
    try {
        debugLog({
            '===开始查询基金': fundCode
        });
        const response = await fetch(`https://fund.eastmoney.com/${fundCode}.html`, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
        });
        if (!response.ok) {
            return {
                code: block_basekit_server_api_1.FieldCode.Error,
                message: `基金代码 ${fundCode} 网络请求失败: ${response.status}`,
                hasValidData: false
            };
        }
        const html = await response.text();
        debugLog({
            '===基金页面HTML长度': html.length,
            '===HTML前500字符': html.substring(0, 500)
        });
        // 解析基金名称
        let fundName = '';
        const namePatterns = [
            /<title>([^<]+?)(?:\s*\([^)]*\))?\s*(?:基金|净值|行情|详情|信息)?.*?<\/title>/i,
            /<h1[^>]*>([^<]+?)\s*\([^)]*\)/i,
            /<h1[^>]*>([^<]+?)<\/h1>/i,
            /class="[^"]*title[^"]*"[^>]*>([^<]+?)\s*\([^)]*\)/i,
            /class="[^"]*name[^"]*"[^>]*>([^<]+?)<\/[^>]+>/i
        ];
        for (const pattern of namePatterns) {
            const nameMatch = html.match(pattern);
            if (nameMatch && nameMatch[1]) {
                fundName = nameMatch[1].trim();
                if (fundName && !fundName.includes('基金') && !fundName.includes('东方财富')) {
                    debugLog({
                        '===匹配到基金名称': fundName,
                        '===使用模式': pattern.toString()
                    });
                    break;
                }
            }
        }
        // 如果没有找到名称，使用默认名称
        if (!fundName) {
            fundName = `基金${fundCode}`;
        }
        // 解析净值 - 使用多种策略
        let netValue = -1; // 默认设为-1
        // 策略1: 提取所有四位小数的数字
        const fourDecimalNumbers = html.match(/\d+\.\d{4}/g) || [];
        debugLog({
            '===找到的四位小数数字': fourDecimalNumbers
        });
        // 策略2: 寻找净值相关的模式
        const netValuePatterns = [
            /(?:最新净值|净值|单位净值|累计净值)[:：\s]*(\d+\.\d{2,4})/gi,
            /(\d+\.\d{4})\s*\|\s*[-+]?\d+\.\d{2}%/g,
            /class="[^"]*(?:net|value|price)[^"]*"[^>]*>.*?(\d+\.\d{2,4})/gi,
            /"(?:netValue|unitNetValue|accumulatedNetValue)"[^>]*>.*?(\d+\.\d{2,4})/gi
        ];
        const foundValues = [];
        for (const pattern of netValuePatterns) {
            let match;
            while ((match = pattern.exec(html)) !== null) {
                const value = parseFloat(match[1]);
                if (!isNaN(value) && value > 0.5 && value < 20) {
                    foundValues.push({
                        value: value,
                        pattern: pattern.toString(),
                        context: match[0]
                    });
                    debugLog({
                        '===找到净值候选': value,
                        '===匹配模式': pattern.toString(),
                        '===上下文': match[0]
                    });
                }
            }
        }
        // 策略3: 在关键词附近搜索数字
        const keywordPatterns = [
            /最新净值[^0-9]*(\d+\.\d{2,4})/gi,
            /单位净值[^0-9]*(\d+\.\d{2,4})/gi,
            /净值[^0-9]*(\d+\.\d{2,4})/gi
        ];
        for (const pattern of keywordPatterns) {
            let match;
            while ((match = pattern.exec(html)) !== null) {
                const value = parseFloat(match[1]);
                if (!isNaN(value) && value > 0.5 && value < 20) {
                    foundValues.push({
                        value: value,
                        pattern: pattern.toString(),
                        context: match[0]
                    });
                }
            }
        }
        // 选择最合理的净值
        if (foundValues.length > 0) {
            // 优先选择在合理范围内的值
            const reasonableValues = foundValues.filter(item => item.value >= 0.5 && item.value <= 20);
            if (reasonableValues.length > 0) {
                // 选择最常见的值或第一个合理值
                netValue = reasonableValues[0].value;
                debugLog({
                    '===选择净值': netValue,
                    '===选择原因': '第一个合理值'
                });
            }
        }
        // 解析日期
        let valueDate = '';
        const datePatterns = [
            /(\d{4}[-\/]\d{1,2}[-\/]\d{1,2})/g,
            /(\d{4}年\d{1,2}月\d{1,2}日)/g,
            /更新时间[^0-9]*(\d{4}[-\/]\d{1,2}[-\/]\d{1,2})/gi,
            /净值日期[^0-9]*(\d{4}[-\/]\d{1,2}[-\/]\d{1,2})/gi
        ];
        for (const pattern of datePatterns) {
            const dateMatch = html.match(pattern);
            if (dateMatch && dateMatch[1]) {
                valueDate = dateMatch[1].replace(/年|月/g, '-').replace(/日/g, '').replace(/\//g, '-');
                break;
            }
        }
        // 如果没有找到日期，使用当前日期
        if (!valueDate) {
            const now = new Date();
            valueDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
        }
        debugLog({
            '===基金解析最终结果': {
                name: fundName,
                netValue: netValue,
                date: valueDate
            }
        });
        // 验证数据完整性
        if (!fundName || fundName.trim() === '') {
            return {
                code: block_basekit_server_api_1.FieldCode.Error,
                message: `基金代码 ${fundCode} 无法解析基金名称`,
                hasValidData: false
            };
        }
        // 价格获取失败时设为-1，但不返回错误
        if (netValue === -1) {
            debugLog({
                '===基金净值获取失败，设为-1': fundCode
            });
        }
        // 验证是否获取到有效数据
        const hasValidData = fundName && fundName !== `基金${fundCode}` && netValue > 0;
        return {
            code: block_basekit_server_api_1.FieldCode.Success,
            data: {
                id: `fund_${fundCode}_${Math.random()}`,
                symbol: fundCode,
                name: fundName,
                price: netValue, // 失败时为-1
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
async function queryStock(stockCode, context, debugLog) {
    try {
        debugLog({
            '===开始查询股票': stockCode
        });
        const symbol = stockCode.toLowerCase();
        const response = await fetch(`https://qt.gtimg.cn/q=${symbol}`, {
            headers: {
                'Referer': 'https://finance.qq.com/',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });
        if (!response.ok) {
            return {
                code: block_basekit_server_api_1.FieldCode.Error,
                message: `股票代码 ${stockCode} 网络请求失败: ${response.status}`
            };
        }
        const text = await response.text();
        debugLog({
            '===股票API响应': text
        });
        if (!text || text.trim() === '') {
            return {
                code: block_basekit_server_api_1.FieldCode.Error,
                message: `股票代码 ${stockCode} 返回空数据`
            };
        }
        // 解析返回的数据
        const dataMatch = text.match(/="([^"]+)"/);
        if (!dataMatch || !dataMatch[1]) {
            return {
                code: block_basekit_server_api_1.FieldCode.Error,
                message: `股票代码 ${stockCode} 数据格式异常`
            };
        }
        const dataStr = dataMatch[1];
        const dataArr = dataStr.split('~');
        debugLog({
            '===股票数据数组': dataArr,
            '===数组长度': dataArr.length
        });
        // 数据字段不足时，price设为-2，但仍返回成功
        if (dataArr.length < 4) {
            debugLog({
                '===股票数据字段不足，price设为-2': stockCode
            });
            // 获取日期信息，使用当前日期
            const now = new Date();
            const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
            return {
                code: block_basekit_server_api_1.FieldCode.Success,
                data: {
                    id: `stock_${symbol}_${Math.random()}`,
                    symbol: symbol,
                    name: `${stockCode}(数据字段不足)`,
                    price: -2, // 数据字段不足时设为-2
                    date: dateStr,
                }
            };
        }
        // 获取股票名称
        let stockName = dataArr[1] || '';
        if (!stockName || stockName.trim() === '') {
            return {
                code: block_basekit_server_api_1.FieldCode.Error,
                message: `股票代码 ${stockCode} 无法获取股票名称`
            };
        }
        // 检查价格数据 - 失败时设为-1
        const priceStr = dataArr[3] || '0';
        let price = parseFloat(priceStr);
        if (isNaN(price) || price <= 0) {
            debugLog({
                '===股票价格获取失败，设为-1': stockCode,
                '===原始价格数据': priceStr
            });
            price = -1; // 价格获取失败时设为-1
        }
        // 处理中文编码问题
        if (stockName.includes('�') || /[^\u4e00-\u9fa5a-zA-Z0-9\s\(\)（）]/.test(stockName)) {
            debugLog({
                '===检测到乱码股票名称': stockName
            });
            try {
                const gbkDecoder = new TextDecoder('gbk');
                const encoder = new TextEncoder();
                const bytes = encoder.encode(stockName);
                const correctedName = gbkDecoder.decode(new Uint8Array(bytes));
                if (correctedName && correctedName !== stockName && !correctedName.includes('�')) {
                    stockName = correctedName;
                    debugLog({
                        '===成功修复股票名称': stockName
                    });
                }
            }
            catch (e) {
                debugLog({
                    '===名称修复失败': String(e)
                });
                // 如果修复失败，但有价格数据，仍然返回结果，只是名称可能有问题
                stockName = `${stockCode}(名称解析异常)`;
            }
        }
        // 获取日期信息，使用当前日期
        const now = new Date();
        const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
        return {
            code: block_basekit_server_api_1.FieldCode.Success,
            data: {
                id: `stock_${symbol}_${Math.random()}`,
                symbol: symbol,
                name: stockName,
                price: price, // 失败时为-1
                date: dateStr,
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi9zcmMvaW5kZXgudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7QUFBQSxtRkFBNkg7QUFDN0gsTUFBTSxFQUFFLENBQUMsRUFBRSxHQUFHLGdDQUFLLENBQUM7QUFFcEIsTUFBTSxRQUFRLEdBQUcsQ0FBQyxXQUFXLEVBQUUsZUFBZSxFQUFFLGtCQUFrQixFQUFFLGVBQWUsQ0FBQyxDQUFDO0FBQ3JGLHFDQUFxQztBQUNyQyxrQ0FBTyxDQUFDLGFBQWEsQ0FBQyxDQUFDLEdBQUcsUUFBUSxFQUFFLGFBQWEsRUFBRSxvQkFBb0IsQ0FBQyxDQUFDLENBQUM7QUFFMUUsa0NBQU8sQ0FBQyxRQUFRLENBQUM7SUFDZixnQkFBZ0I7SUFDaEIsSUFBSSxFQUFFO1FBQ0osUUFBUSxFQUFFO1lBQ1IsT0FBTyxFQUFFO2dCQUNQLFdBQVcsRUFBRSxTQUFTO2dCQUN0QixZQUFZLEVBQUUsT0FBTztnQkFDckIsV0FBVyxFQUFFLElBQUk7Z0JBQ2pCLGVBQWUsRUFBRSxNQUFNO2dCQUN2QixhQUFhLEVBQUUsNERBQTREO2FBQzVFO1lBQ0QsT0FBTyxFQUFFO2dCQUNQLFdBQVcsRUFBRSxpQkFBaUI7Z0JBQzlCLFlBQVksRUFBRSxXQUFXO2dCQUN6QixXQUFXLEVBQUUsTUFBTTtnQkFDbkIsZUFBZSxFQUFFLFlBQVk7Z0JBQzdCLGFBQWEsRUFBRSx3RkFBd0Y7YUFDeEc7WUFDRCxPQUFPLEVBQUU7Z0JBQ1AsV0FBVyxFQUFFLFlBQVk7Z0JBQ3pCLFlBQVksRUFBRSxTQUFTO2dCQUN2QixXQUFXLEVBQUUsSUFBSTtnQkFDakIsZUFBZSxFQUFFLEtBQUs7Z0JBQ3RCLGFBQWEsRUFBRSx3RUFBd0U7YUFDeEY7U0FDRjtLQUNGO0lBQ0QsVUFBVTtJQUNWLFNBQVMsRUFBRTtRQUNUO1lBQ0UsR0FBRyxFQUFFLFdBQVc7WUFDaEIsS0FBSyxFQUFFLENBQUMsQ0FBQyxXQUFXLENBQUM7WUFDckIsU0FB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