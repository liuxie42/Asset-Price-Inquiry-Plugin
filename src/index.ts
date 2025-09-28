import { basekit, FieldType, field, FieldComponent, FieldCode, NumberFormatter } from '@lark-opdev/block-basekit-server-api';
const { t } = field;

const feishuDm = ['feishu.cn', 'feishucdn.com', 'larksuitecdn.com', 'larksuite.com'];
// 通过addDomainList添加请求接口的域名，支持股票和基金查询
basekit.addDomainList([...feishuDm, 'qt.gtimg.cn', 'fund.eastmoney.com']);

basekit.addField({
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
      component: FieldComponent.Input,
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
          type: FieldType.Number,
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
  // formItemParams 为运行时传入的字段参数，对应字段配置里的 formItems （如引用的依赖字段）
  execute: async (formItemParams: { stockCode: string }, context) => {
    const { stockCode = '' } = formItemParams;
    
    // 为空或者不是有效的代码格式时返回错误
    if (!stockCode || !stockCode.trim()) {
      return {
        code: FieldCode.Error,
        message: '请输入有效的股票或基金代码'
      };
    }

    /** 为方便查看日志，使用此方法替代console.log */
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
      
      // 判断是基金代码还是股票代码
      // 优先尝试基金查询，如果失败再尝试股票查询
      const isFundCode = /^\d{6}$/.test(inputCode);
      
      if (isFundCode) {
        // 先尝试基金查询
        const fundResult = await queryFund(inputCode, context, debugLog);
        
        // 如果基金查询成功且有有效数据，返回结果
        if (fundResult.code === FieldCode.Success && fundResult.hasValidData) {
          return {
            code: fundResult.code,
            data: fundResult.data
          };
        }
        
        // 如果基金查询失败，记录错误并尝试股票查询
        if (fundResult.code === FieldCode.Error) {
          debugLog({
            '===基金查询失败，尝试股票查询': fundResult.message || '基金查询失败'
          });
        }
      }
      
      // 基金查询失败或不是基金代码，尝试股票查询
      const stockResult = await queryStock(inputCode, context, debugLog);
      
      if (stockResult.code === FieldCode.Success) {
        return {
          code: stockResult.code,
          data: stockResult.data
        };
      } else {
        // 如果股票查询也失败，返回更详细的错误信息
        let errorMessage = (stockResult as any).message || '查询失败';
        
        // 如果之前基金查询也失败了，合并错误信息
        if (isFundCode) {
          errorMessage = `基金和股票查询均失败。${errorMessage}`;
        }
        
        return {
          code: FieldCode.Error,
          message: errorMessage
        };
      }
      
    } catch (e) {
      console.log('====error', String(e));
      debugLog({
        '===999 异常错误': String(e)
      });
      
      return {
        code: FieldCode.Error,
        message: `系统异常: ${String(e)}`
      };
    }
  },
});

// 基金查询函数
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

    const response = await fetch(`https://fund.eastmoney.com/${fundCode}.html`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    });

    if (!response.ok) {
      return {
        code: FieldCode.Error,
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
        code: FieldCode.Error,
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
      code: FieldCode.Success,
      data: {
        id: `fund_${fundCode}_${Math.random()}`,
        symbol: fundCode,
        name: fundName,
        price: netValue, // 失败时为-1
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
    const response = await fetch(`https://qt.gtimg.cn/q=${symbol}`, {
      headers: {
        'Referer': 'https://finance.qq.com/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    if (!response.ok) {
      return {
        code: FieldCode.Error,
        message: `股票代码 ${stockCode} 网络请求失败: ${response.status}`
      };
    }

    const text = await response.text();
    debugLog({
      '===股票API响应': text
    });

    if (!text || text.trim() === '') {
      return {
        code: FieldCode.Error,
        message: `股票代码 ${stockCode} 返回空数据`
      };
    }

    // 解析返回的数据
    const dataMatch = text.match(/="([^"]+)"/);
    if (!dataMatch || !dataMatch[1]) {
      return {
        code: FieldCode.Error,
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
        code: FieldCode.Success,
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
        code: FieldCode.Error,
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
      } catch (e) {
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
      code: FieldCode.Success,
      data: {
        id: `stock_${symbol}_${Math.random()}`,
        symbol: symbol,
        name: stockName,
        price: price, // 失败时为-1
        date: dateStr,
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