/** Sub-Store Workers Express 适配层 */

export default function express({ substore: $ }) {
    const DEFAULT_HEADERS = {
        'Content-Type': 'text/plain;charset=UTF-8',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST,GET,OPTIONS,PATCH,PUT,DELETE',
        'Access-Control-Allow-Headers':
            'Origin, X-Requested-With, Content-Type, Accept',
        'X-Powered-By': 'Sub-Store-Workers',
    };

    // 路由处理器
    const handlers = [];
    // 中间件栈
    const middlewares = [];

    // HTTP 方法
    const METHODS_NAMES = [
        'GET',
        'POST',
        'PUT',
        'DELETE',
        'PATCH',
        'OPTIONS',
        'HEAD',
        'ALL',
    ];

    const app = {};

    // 注册中间件
    app.use = (fn) => {
        middlewares.push(fn);
    };

    // 注册路由方法
    METHODS_NAMES.forEach((method) => {
        app[method.toLowerCase()] = (pattern, callback) => {
            handlers.push({ method, pattern, callback });
        };
    });

    // 链式路由
    app.route = (pattern) => {
        const chainApp = {};
        METHODS_NAMES.forEach((method) => {
            chainApp[method.toLowerCase()] = (callback) => {
                handlers.push({ method, pattern, callback });
                return chainApp;
            };
        });
        return chainApp;
    };

    // 空操作
    app.start = () => {};

    /** 处理请求 */
    app.handleRequest = async (request) => {
        // CORS 预检已在 index.js 外层处理，此处直接进入路由

        const url = new URL(request.url);
        const method = request.method.toUpperCase();
        const path = decodeURIComponent(url.pathname);
        const query = {};
        url.searchParams.forEach((value, key) => {
            query[key] = value;
        });

        // 解析请求体
        let body = null;
        if (!['GET', 'HEAD'].includes(method)) {
            const contentType = request.headers.get('content-type') || '';
            if (contentType.includes('json')) {
                try {
                    body = await request.json();
                } catch (e) {
                    body = null;
                }
            } else {
                try {
                    body = await request.text();
                } catch (e) {
                    body = null;
                }
            }
        }

        // 转换请求头
        const headers = {};
        request.headers.forEach((value, key) => {
            headers[key.toLowerCase()] = value;
        });

        // 构建 req 对象
        const req = {
            method,
            url: url.pathname + url.search,
            path,
            query,
            params: {},
            headers,
            body,
            socket: {
                remoteAddress:
                    request.headers.get('cf-connecting-ip') || undefined,
            },
            _parsedUrl: { pathname: path },
        };

        // 构建 res 对象
        let responded = false;
        let responseResolve;
        const responsePromise = new Promise((resolve) => {
            responseResolve = resolve;
        });

        const resHeaders = { ...DEFAULT_HEADERS };
        let resStatusCode = 200;

        const res = {
            req, // 反向引用
            // Upstream response-transformer relies on statusCode / getHeaders();
            // without them header transforms cannot see headers such as the
            // already-set Content-Type, and the status stays 200.
            get statusCode() {
                return resStatusCode;
            },
            set statusCode(code) {
                resStatusCode = code;
            },
            getHeaders() {
                return { ...resHeaders };
            },
            getHeader(key) {
                const target = String(key).toLowerCase();
                for (const name of Object.keys(resHeaders)) {
                    if (name.toLowerCase() === target) return resHeaders[name];
                }
                return undefined;
            },
            status(code) {
                resStatusCode = code;
                return this;
            },
            set(key, val) {
                if (typeof key === 'object') {
                    Object.assign(resHeaders, key);
                } else {
                    resHeaders[key] = val;
                }
                return this;
            },
            setHeader(key, val) {
                resHeaders[key] = val;
                return this;
            },
            removeHeader(key) {
                delete resHeaders[key];
                return this;
            },
            send(body = '') {
                if (responded) return;
                responded = true;
                responseResolve(
                    new Response(body, {
                        status: resStatusCode,
                        headers: resHeaders,
                    }),
                );
            },
            end() {
                this.send('');
            },
            json(data) {
                resHeaders['Content-Type'] = 'application/json;charset=UTF-8';
                this.send(JSON.stringify(data));
            },
            html(data) {
                resHeaders['Content-Type'] = 'text/html;charset=UTF-8';
                this.send(data);
            },
        };

        // 执行中间件链
        const runMiddlewares = async (idx) => {
            if (idx >= middlewares.length) {
                // 分发到路由
                await dispatchRoute(method, path, query, req, res);
                return;
            }
            const mw = middlewares[idx];
            await new Promise((resolve, reject) => {
                try {
                    const result = mw(req, res, () => resolve());
                    if (result && typeof result.then === 'function') {
                        result.then(() => resolve()).catch(reject);
                    }
                } catch (e) {
                    reject(e);
                }
            });
            if (!responded) {
                await runMiddlewares(idx + 1);
            }
        };

        try {
            await runMiddlewares(0);
        } catch (e) {
            if (!responded) {
                responseResolve(
                    new Response(
                        JSON.stringify({
                            status: 'failed',
                            message: `Internal Server Error: ${e.message || e}`,
                        }),
                        {
                            status: 500,
                            headers: {
                                ...DEFAULT_HEADERS,
                                'Content-Type': 'application/json;charset=UTF-8',
                            },
                        },
                    ),
                );
            }
        }

        // 未匹配返回 404
        if (!responded) {
            responseResolve(
                new Response(
                    JSON.stringify({
                        status: 'failed',
                        message: 'ERROR: 404 not found',
                    }),
                    {
                        status: 404,
                        headers: {
                            ...DEFAULT_HEADERS,
                            'Content-Type': 'application/json;charset=UTF-8',
                        },
                    },
                ),
            );
        }

        return responsePromise;
    };

    // 匹配最优路由
    async function dispatchRoute(method, path, query, req, res) {
        let handler = null;
        let longestMatchedPattern = 0;

        for (let i = 0; i < handlers.length; i++) {
            if (
                handlers[i].method === 'ALL' ||
                method === handlers[i].method
            ) {
                const { pattern } = handlers[i];
                if (patternMatched(pattern, path)) {
                    const len =
                        typeof pattern === 'string'
                            ? pattern.split('/').length
                            : path.length;
                    if (len > longestMatchedPattern) {
                        handler = handlers[i];
                        longestMatchedPattern = len;
                    }
                }
            }
        }

        if (handler) {
            req.params = extractPathParams(handler.pattern, path) || {};
            req.route = { path: handler.pattern };
            const cb = handler.callback;
            try {
                // Await any thenable, not only `async` functions: a plain
                // function returning a Promise was previously not awaited, so
                // the response could be lost / fall through to a premature 404.
                const ret = cb(req, res, () => {});
                if (ret && typeof ret.then === 'function') {
                    await ret;
                }
            } catch (err) {
                res.status(500).json({
                    status: 'failed',
                    message: `Internal Server Error: ${err.message || err}`,
                });
            }
        }
        // 无匹配由外层 404
    }

    return app;
}

// ---- 工具函数 ----

function patternMatched(pattern, path) {
    if (pattern instanceof RegExp && pattern.test(path)) {
        return true;
    } else {
        if (pattern === '/') return path === '/';
        if (pattern.indexOf(':') === -1) {
            const spath = path.split('/');
            const spattern = pattern.split('/');
            for (let i = 0; i < spattern.length; i++) {
                if (spath[i] !== spattern[i]) {
                    return false;
                }
            }
            return true;
        } else if (extractPathParams(pattern, path)) {
            return true;
        }
    }
    return false;
}

function extractPathParams(pattern, path) {
    if (typeof pattern !== 'string' || pattern.indexOf(':') === -1) {
        return null;
    }
    const params = {};
    for (let i = 0, j = 0; i < pattern.length; i++, j++) {
        if (pattern[i] === ':') {
            let key = [];
            let val = [];
            while (pattern[++i] !== '/' && i < pattern.length) {
                key.push(pattern[i]);
            }
            while (path[j] !== '/' && j < path.length) {
                val.push(path[j++]);
            }
            // path was already decoded once in handleRequest; do not decode
            // again here, otherwise params containing % get corrupted (and a
            // stray % throws URIError, producing a 500).
            params[key.join('')] = val.join('');
        } else {
            if (pattern[i] !== path[j]) {
                return null;
            }
        }
    }
    return params;
}
