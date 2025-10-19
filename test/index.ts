import { testField, createFieldContext } from "@lark-opdev/block-basekit-server-api";

// 导入清理函数
let stopCacheCleanup: (() => void) | undefined;
try {
  const indexModule = require('../src/index');
  stopCacheCleanup = indexModule.stopCacheCleanup;
} catch (error) {
  console.warn('Could not import stopCacheCleanup function:', error);
}

/**
 * 测试股票价格查询功能
 */
describe('Asset Price Inquiry Tests', () => {
    // 增加测试超时时间
    jest.setTimeout(15000);

    test('should query stock price successfully', async () => {
        const context = await createFieldContext();
        const result = await testField({
            stockCode: "sz300750",
            queryDate: "2025-10-16"
        }, context);
        
        expect(result).toBeDefined();
        console.log('Stock test result:', result);
        
        // 确保清理异步资源
        if (context && typeof context.cleanup === 'function') {
            await context.cleanup();
        }
    });

    test('should query fund price successfully', async () => {
        const context = await createFieldContext();
        const result = await testField({
            stockCode: "000311",
            queryDate: "2025-10-16"
        }, context);
        
        expect(result).toBeDefined();
        console.log('Fund test result:', result);
        
        // 确保清理异步资源
        if (context && typeof context.cleanup === 'function') {
            await context.cleanup();
        }
    });

    // 全局清理
    afterAll(async () => {
        // 停止缓存清理定时器
        if (stopCacheCleanup) {
            stopCacheCleanup();
        }
        
        // 等待所有异步操作完成
        await new Promise(resolve => setTimeout(resolve, 100));
    });
});

// 保留原有的直接运行函数用于调试
async function run() {
    const context = await createFieldContext();
    try {
        await testField({
            stockCode: "sz300750",
            queryDate: "2025-10-16"
        }, context);
    } finally {
        // 确保清理资源
        if (context && typeof context.cleanup === 'function') {
            await context.cleanup();
        }
        
        // 停止缓存清理定时器
        if (stopCacheCleanup) {
            stopCacheCleanup();
        }
    }
}

// 仅在直接运行时执行
if (require.main === module) {
    run().then(() => process.exit(0));
}
