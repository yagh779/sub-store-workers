/** Sub-Store Workers 入口 */

import { version as workersVersion } from '../package.json';
import { version as substoreVersion } from '../../Sub-Store/backend/package.json';
const version = `${substoreVersion}(w${workersVersion})`;
import $ from '@/core/app';
import express from '@/vendor/express';
import migrate from '@/utils/migration';

import registerSubscriptionRoutes from '@/restful/subscriptions';
import registerCollectionRoutes from '@/restful/collections';
import registerArtifactRoutes from '@/restful/artifacts';
import registerFileRoutes from '@/restful/file';
import registerTokenRoutes from '@/restful/token';
import registerArchiveRoutes from '@/restful/archives';
import registerModuleRoutes from '@/restful/module';
import registerSyncRoutes from '@/restful/sync';
import registerDownloadRoutes from '@/restful/download';
import registerSettingRoutes from '@/restful/settings';
import registerPreviewRoutes from '@/restful/preview';
import registerSortingRoutes from '@/restful/sort';
import registerMiscRoutes from '@/restful/miscs';
import registerNodeInfoRoutes from '@/restful/node-info';
import registerParserRoutes from '@/restful/parser';
import registerLogRoutes from '@/restful/logs';
import registerAgeRoutes from '@/restful/age';

import { consumeShareToken } from '@/restful/token';
import { SETTINGS_KEY } from '@/constants';
import {
    normalizeBackendPath,
    matchesBackendPath,
    stripBackendPath,
} from '@/utils/backend-path';

// CORS 响应头。集中在一处，便于后续从 '*' 收紧为白名单时单点修改
// （上游 2.38.x 起默认已不再是 '*'，见 ../Sub-Store/backend/src/utils/cors.js）
const CORS_HEADERS = { 'Access-Control-Allow-Origin': '*' };

/**
 * 统一构造 `{ status: 'failed', message }` 形态的 JSON 失败响应。
 *
 * @param {number} status - HTTP 状态码
 * @param {string} message - 失败原因
 * @returns {Response}
 */
function jsonFailure(status, message) {
    return new Response(JSON.stringify({ status: 'failed', message }), {
        status,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    });
}

/**
 * 回写 KV 并确保推送完成。正常返回与异常兜底两条路径都要执行。
 *
 * @param {ExecutionContext} ctx
 */
function flushPending(ctx) {
    ctx.waitUntil(
        Promise.all([$.persistCache(), ...($.pendingPushes || [])]),
    );
    $.pendingPushes = [];
}

// 初始化应用及路由
const $app = express({ substore: $ });

registerCollectionRoutes($app);
registerSubscriptionRoutes($app);
registerDownloadRoutes($app);
registerPreviewRoutes($app);
registerSortingRoutes($app);
registerSettingRoutes($app);
registerArtifactRoutes($app);
registerFileRoutes($app);
registerTokenRoutes($app);
registerArchiveRoutes($app);
registerModuleRoutes($app);
registerSyncRoutes($app);
registerNodeInfoRoutes($app);
registerMiscRoutes($app);
registerParserRoutes($app);
registerLogRoutes($app);
registerAgeRoutes($app);

export default {
    async fetch(request, env, ctx) {
        try {
            const kvError = validateKVBinding(env);
            if (kvError) return kvError.response;

            // CORS 预检
            if (request.method === 'OPTIONS') {
                return new Response(null, {
                    headers: {
                        ...CORS_HEADERS,
                        'Access-Control-Allow-Methods': '*',
                        'Access-Control-Allow-Headers': '*',
                        'Access-Control-Max-Age': '86400',
                    },
                });
            }

            const url = new URL(request.url);
            let pathname = url.pathname;

            // 路径前缀鉴权（可选）
            // 配置 SUB_STORE_FRONTEND_BACKEND_PATH = "/你的密码" 后
            // 前端后端地址填: https://xxx.pages.dev/你的密码
            // 管理 API 需要带前缀才能访问，分享链接（download/preview）不受影响
            //
            // 归一化处理 '/'、'/密码/'、'密码' 这几种会锁死部署的写法（详见
            // @/utils/backend-path）：归一化后为空串时按「未设置」处理，管理 API
            // 公开并发出安全告警，而不是全部返回 401 且无任何入口。
            const backendPath = normalizeBackendPath(
                env.SUB_STORE_FRONTEND_BACKEND_PATH,
            );
            const isPublicPath = /^\/(api\/download|api\/preview|api\/sub\/flow)/.test(pathname);
            const isManagementApi = !isPublicPath && pathname.startsWith('/api/');
            const isAuthDisabledManagementApi = !backendPath && isManagementApi;
            if (isAuthDisabledManagementApi) {
                console.warn(`[Security] SUB_STORE_FRONTEND_BACKEND_PATH is not configured; management API is publicly accessible: ${pathname}`);
            }
            if (backendPath) {
                if (!isPublicPath && pathname.startsWith('/api/')) {
                    // 直接访问 /api/* 没带前缀，拒绝
                    return jsonFailure(401, 'Unauthorized');
                }
                if (pathname === backendPath) {
                    // 精确匹配前缀，重定向到带 / 的路径
                    return new Response(null, {
                        status: 302,
                        headers: {
                            'Location': new URL(backendPath + '/', request.url).toString(),
                            ...CORS_HEADERS,
                        },
                    });
                }
                if (matchesBackendPath(pathname, backendPath)) {
                    // 带了前缀，剥离后交给路由
                    pathname = stripBackendPath(pathname, backendPath);
                    const newUrl = new URL(request.url);
                    newUrl.pathname = pathname;
                    // 通过密码前缀访问才注入 share 标记（与上游 be_merge 行为一致）
                    if (pathname.startsWith('/api/')) {
                        newUrl.searchParams.set('share', 'true');
                    }
                    request = new Request(newUrl.toString(), request);
                }
            }

            // 注入环境变量
            globalThis.__workerEnv = env;

            // 从 KV 加载数据
            await $.initFromKV(env.SUB_STORE_DATA);
            $.workerEnv = env;

            // 数据迁移
            migrate();

            console.log(`Sub-Store Workers v${version} handling: ${request.method} ${pathname}`);

            // /share/ 路由的 token 验证（与上游 Node.js 版 be_merge 行为一致）
            // 所有 /share/ 请求都必须携带有效 token，未分享的订阅/文件不可直接访问
            if (pathname.startsWith('/share/')) {
                if (request.method.toUpperCase() !== 'GET') {
                    return jsonFailure(405, 'Method not allowed');
                }
                const tokenValue = url.searchParams.get('token');
                if (!tokenValue) {
                    // 未提供 token，拒绝访问
                    return jsonFailure(403, 'Share token is required');
                }
                const decodedPathname = decodeURIComponent(pathname);
                const shareToken = consumeShareToken({
                    token: tokenValue,
                    pathname: decodedPathname,
                });
                if (!shareToken) {
                    // token 无效
                    const settings = $.read(SETTINGS_KEY);
                    if (settings?.appearanceSetting?.invalidShareFakeNode) {
                        // 返回假节点
                        const fakeUrl = new URL(request.url);
                        fakeUrl.pathname = pathname.replace(/\/share\/.*?\//, '/share/sub/');
                        fakeUrl.searchParams.set('_fakeNode', 'true');
                        request = new Request(fakeUrl.toString(), request);
                    } else {
                        return jsonFailure(404, 'Invalid or expired share token');
                    }
                }
                // token 有效，继续正常路由
            }

            // 路由分发
            const response = await $app.handleRequest(request);

            // 禁止 Cloudflare CDN/边缘节点缓存动态 API 响应
            // 未设置此头时，不同 URL 路径（如 /share/ 和 /download/）的响应可能被独立缓存，
            // 导致同一订阅在不同接口返回不一致（陈旧）的数据
            response.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate');
            response.headers.set('CDN-Cache-Control', 'no-store');

            if (isAuthDisabledManagementApi) {
                response.headers.set('X-Sub-Store-Security-Warning', 'SUB_STORE_FRONTEND_BACKEND_PATH is not configured; management API is public');
            }

            // 回写 KV + 确保推送完成
            flushPending(ctx);

            return response;
        } catch (e) {
            console.error(`Unhandled error: ${e.message}\n${e.stack}`);
            // 出错也尝试回写
            flushPending(ctx);
            return jsonFailure(500, 'Internal Server Error');
        }
    },
};

function validateKVBinding(env) {
    if (env?.SUB_STORE_DATA?.get && env?.SUB_STORE_DATA?.put) return null;
    return {
        message: 'Missing KV binding: SUB_STORE_DATA',
        response: jsonFailure(
            500,
            'Missing KV binding: SUB_STORE_DATA. Please bind a Cloudflare KV namespace named SUB_STORE_DATA before running Sub-Store Workers.',
        ),
    };
}
