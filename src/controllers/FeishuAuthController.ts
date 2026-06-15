/**
 * 飞书OAuth授权 + 消息订阅控制器
 *
 * 功能：
 * 1. 飞书OAuth2.0授权回调
 * 2. 用户订阅状态查询/变更
 * 3. 飞书Bot消息推送
 */

import { Request, Response, NextFunction } from 'express';
import { createResponse } from '../utils/response';
import pool from '../db';
import axios from 'axios';

// 飞书应用配置
const FEISHU_APP_ID = process.env.FEISHU_APP_ID || '';
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET || '';
const FEISHU_BASE_URL = 'https://open.feishu.cn/open-apis';

// ==================== 数据库Schema ====================

async function ensureSubscriptionSchema(): Promise<void> {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS user_subscriptions (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            feishu_open_id TEXT NOT NULL DEFAULT '',
            feishu_user_id TEXT NOT NULL DEFAULT '',
            feishu_name TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'idle',
            push_times TEXT[] DEFAULT '{"09:00","13:00","19:00"}',
            subscribed_at TIMESTAMPTZ,
            unsubscribed_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE(user_id)
        );
        CREATE INDEX IF NOT EXISTS idx_us_user_id ON user_subscriptions(user_id);
        CREATE INDEX IF NOT EXISTS idx_us_feishu_open_id ON user_subscriptions(feishu_open_id);
    `);
}

// ==================== 飞书API调用 ====================

async function getFeishuAppToken(): Promise<string> {
    const res = await axios.post(
        `${FEISHU_BASE_URL}/auth/v3/app_access_token/internal`,
        {
            app_id: FEISHU_APP_ID,
            app_secret: FEISHU_APP_SECRET,
        },
    );
    return res.data?.app_access_token || '';
}

async function getFeishuUserToken(code: string): Promise<any> {
    const appToken = await getFeishuAppToken();
    const res = await axios.post(
        `${FEISHU_BASE_URL}/authen/v1/oidc/access_token`,
        {
            grant_type: 'authorization_code',
            code,
        },
        {
            headers: { Authorization: `Bearer ${appToken}` },
        },
    );
    return res.data?.data;
}

async function getFeishuUserInfo(userAccessToken: string): Promise<any> {
    const res = await axios.get(`${FEISHU_BASE_URL}/authen/v1/user_info`, {
        headers: { Authorization: `Bearer ${userAccessToken}` },
    });
    return res.data?.data;
}

async function sendFeishuMessage(openId: string, msgType: string, content: any): Promise<boolean> {
    try {
        const appToken = await getFeishuAppToken();
        await axios.post(
            `${FEISHU_BASE_URL}/im/v1/messages?receive_id_type=open_id`,
            {
                receive_id: openId,
                msg_type: msgType,
                content: typeof content === 'string' ? content : JSON.stringify(content),
            },
            {
                headers: {
                    Authorization: `Bearer ${appToken}`,
                    'Content-Type': 'application/json',
                },
            },
        );
        return true;
    } catch (err: any) {
        console.error('[FeishuAuth] 发送消息失败:', err?.response?.data || err.message);
        return false;
    }
}

// ==================== 控制器 ====================

export class FeishuAuthController {
    /**
     * GET /api/auth/feishu/callback
     * 飞书OAuth2.0授权回调
     */
    static async oauthCallback(req: Request, res: Response, _next: NextFunction): Promise<void> {
        try {
            const { code, state } = req.query;
            if (!code) {
                res.redirect('/?error=feishu_auth_failed');
                return;
            }

            // 获取用户Token
            const tokenData = await getFeishuUserToken(String(code));
            if (!tokenData?.access_token) {
                console.error('[FeishuAuth] 获取用户token失败:', tokenData);
                res.redirect('/?error=feishu_token_failed');
                return;
            }

            // 获取用户信息
            const userInfo = await getFeishuUserInfo(tokenData.access_token);
            if (!userInfo?.open_id) {
                console.error('[FeishuAuth] 获取用户信息失败:', userInfo);
                res.redirect('/?error=feishu_userinfo_failed');
                return;
            }

            // 从Cookie中获取当前登录用户ID
            const userId = (req as any).user?.id;
            if (!userId) {
                res.redirect('/login?error=session_expired');
                return;
            }

            // 保存飞书绑定信息
            await ensureSubscriptionSchema();
            await pool.query(
                `INSERT INTO user_subscriptions (user_id, feishu_open_id, feishu_user_id, feishu_name, status, subscribed_at)
                 VALUES ($1, $2, $3, $4, 'subscribed', NOW())
                 ON CONFLICT (user_id)
                 DO UPDATE SET feishu_open_id = $2, feishu_user_id = $3, feishu_name = $4, status = 'subscribed', subscribed_at = NOW(), updated_at = NOW()`,
                [userId, userInfo.open_id, userInfo.user_id || '', userInfo.name || ''],
            );

            console.log(`[FeishuAuth] 用户${userId}绑定飞书成功: open_id=${userInfo.open_id}, name=${userInfo.name}`);

            // 重定向回原页面
            const redirectPath = state ? decodeURIComponent(String(state)) : '/';
            res.redirect(redirectPath);
        } catch (err: any) {
            console.error('[FeishuAuth] oauthCallback error:', err.message);
            res.redirect('/?error=feishu_auth_error');
        }
    }

    /**
     * GET /api/users/me/subscription
     * 查询当前用户订阅状态
     */
    static async getSubscription(req: Request, res: Response, _next: NextFunction): Promise<void> {
        try {
            const userId = (req as any).user?.id;
            if (!userId) {
                createResponse(res, 401, '未登录');
                return;
            }

            await ensureSubscriptionSchema();
            const result = await pool.query(
                'SELECT status, feishu_open_id, feishu_name, push_times, subscribed_at FROM user_subscriptions WHERE user_id = $1',
                [userId],
            );

            if (result.rows.length === 0) {
                createResponse(res, 200, 'success', { status: 'idle' });
                return;
            }

            const row = result.rows[0];
            const status = row.status === 'subscribed' && row.feishu_open_id ? 'subscribed' : 'unauthorized';
            createResponse(res, 200, 'success', {
                status,
                feishuName: row.feishu_name,
                pushTimes: row.push_times,
                subscribedAt: row.subscribed_at,
            });
        } catch (err: any) {
            const errMsg = err instanceof Error ? err.message : String(err);
            console.error('[FeishuAuth] getSubscription error:', errMsg);
            createResponse(res, 500, errMsg);
        }
    }

    /**
     * POST /api/users/me/subscription
     * 订阅/取消订阅
     */
    static async updateSubscription(req: Request, res: Response, _next: NextFunction): Promise<void> {
        try {
            const userId = (req as any).user?.id;
            if (!userId) {
                createResponse(res, 401, '未登录');
                return;
            }

            const { action } = req.body;
            await ensureSubscriptionSchema();

            if (action === 'subscribe') {
                // 检查是否已绑定飞书
                const existing = await pool.query(
                    'SELECT feishu_open_id FROM user_subscriptions WHERE user_id = $1',
                    [userId],
                );

                if (existing.rows.length === 0 || !existing.rows[0].feishu_open_id) {
                    createResponse(res, 200, '需要先授权飞书账号', { status: 'unauthorized' });
                    return;
                }

                await pool.query(
                    `UPDATE user_subscriptions SET status = 'subscribed', subscribed_at = NOW(), updated_at = NOW() WHERE user_id = $1`,
                    [userId],
                );
                createResponse(res, 200, '订阅成功', { status: 'subscribed' });
            } else if (action === 'unsubscribe') {
                await pool.query(
                    `UPDATE user_subscriptions SET status = 'unsubscribed', unsubscribed_at = NOW(), updated_at = NOW() WHERE user_id = $1`,
                    [userId],
                );
                createResponse(res, 200, '取消订阅成功', { status: 'idle' });
            } else if (action === 'unbind') {
                await pool.query(
                    `UPDATE user_subscriptions SET status = 'unbound', feishu_open_id = '', feishu_user_id = '', feishu_name = '', unsubscribed_at = NOW(), updated_at = NOW() WHERE user_id = $1`,
                    [userId],
                );
                createResponse(res, 200, '已解除飞书绑定', { status: 'idle' });
            } else {
                createResponse(res, 400, '无效操作');
            }
        } catch (err: any) {
            const errMsg = err instanceof Error ? err.message : String(err);
            console.error('[FeishuAuth] updateSubscription error:', errMsg);
            createResponse(res, 500, errMsg);
        }
    }

    /**
     * POST /api/internal/push-feishu
     * 内部接口：向指定用户推送飞书消息
     */
    static async pushMessage(req: Request, res: Response, _next: NextFunction): Promise<void> {
        try {
            const token = req.headers['x-internal-token'];
            if (token !== (process.env.INTERNAL_TOKEN || 'crawler-int-2026-token')) {
                createResponse(res, 401, 'invalid internal token');
                return;
            }

            const { open_id, msg_type, content } = req.body;
            if (!open_id || !msg_type || !content) {
                createResponse(res, 400, '参数不完整');
                return;
            }

            const success = await sendFeishuMessage(open_id, msg_type, content);
            createResponse(res, success ? 200 : 500, success ? 'success' : '推送失败');
        } catch (err: any) {
            const errMsg = err instanceof Error ? err.message : String(err);
            console.error('[FeishuAuth] pushMessage error:', errMsg);
            createResponse(res, 500, errMsg);
        }
    }
}
