/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Bind resources to your worker in `wrangler.toml`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run cf-typegen`.
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

interface CreateOrderRequest {
	oid: string;
	uid: string;
	amount: number;

	memo: string;
	expiredAt: number;
	timestamp: number;
	nonce: string;
	mchId: string;
	notifyUrl: string;
	redirectUrl: string;
	sign?: string;

}

interface CreateOrderResponse {
	code: number;
	message: string;
	data: {
		id: string;
		[key: string]: any;
	};
}

interface NotifyRequest {
	oid: string;
	id: string;
	uid: string;
	timestamp: number;
	nonce: string;
	status: number;
	statusCode: number;
	sign?: string;
}

// sign
async function generateSign(data: any, appSecret: string): Promise<ArrayBuffer> {
	const keys = Object.keys(data).sort();
	let str = '';
	for (const key of keys) {
		str += `${key}=${data[key]}&`;
	}
	str = str.slice(0, -1);
	str += appSecret;
	console.log("base string: ", str);
	return crypto.subtle.digest('SHA-256', new TextEncoder().encode(str)).then((hash) => {
		return hash;
	});
}
// simple ip rate limiter with kv
async function rateLimit(ip: string, env: any): Promise<boolean> {
	const clientIp = ip;
	const key = `rate-limit-${clientIp}`;
	if (!env.KV_NAMESPACE) {
		return true;
	}
	const currentCount = await env.KV_NAMESPACE.get(key);
	if (currentCount === null) {
		await env.KV_NAMESPACE.put(key, '1', { expirationTtl: 60 });
		return true;
	} else {
		const count = parseInt(currentCount);
		if (count >= 5) {
			return false;
		}
		await env.KV_NAMESPACE.put(key, (count + 1).toString(), { expirationTtl: 60 });
		return true;
	}
}

// create order
async function createOrder(oid: string, uid: string, amount: number, env: any): Promise<string> {
	const ts = Date.now();

	const data: CreateOrderRequest = {
		oid,
		uid,
		amount: amount,
		memo: 'testpayment',
		expiredAt: (ts + 3600000),
		timestamp: ts,
		nonce: Math.random().toString(36).slice(2),
		mchId: "1",
		notifyUrl: env.UPAY_NOTIFY, // from env
		redirectUrl: env.UPAY_REDIRECT, // from env
	};
	const hash = await generateSign(data, env.UPAY_PAYMENT_KEY);
	const hashHex: string = Array.prototype.map.call(new Uint8Array(hash), x => ('00' + x.toString(16)).slice(-2)).join('');
	data['sign'] = hashHex;

	console.log(`sign ${hashHex}`);

	const url = new URL(`${env.UPAY_API}/api/v1/order`);
	// post
	const response = await fetch(url.toString(), {
		method: 'POST',
		body: JSON.stringify(data),
		headers: {
			'Content-Type': 'application/json',
		},
	});

	const result: CreateOrderResponse = await response.json();
	console.log(result);

	if (result.code === 1) {
		const redirectUrl = `${env.UPAY_UI}${result.data.id}`;
		return redirectUrl;
	} else {
		return '';
	}
}

// verify notify and return response success
async function verifyNotify(data: NotifyRequest, env: any): Promise<boolean> {
	const sign = data.sign;
	delete data.sign;
	const appSecret = env.UPAY_PAYMENT_KEY;
	const hash = await generateSign(data, appSecret);
	const hashHex: string = Array.prototype.map.call(new Uint8Array(hash), x => ('00' + x.toString(16)).slice(-2)).join('');
	return hashHex === sign;
}

export default {
	async fetch(request, env, ctx): Promise<Response> {

		const url = new URL(request.url);
		if (url.pathname === '/hello') {
			return new Response('Hello World!');
		} else if (url.pathname === '/create-order') {
			// rate limit
			const ip = request.headers.get('cf-connecting-ip');
			if (!ip) {
				return new Response('No ip', { status: 400 });
			}
			const limit = await rateLimit(ip, env);
			if (!limit) {
				return new Response('Too many requests', { status: 429 });
			}

			// random oid
			const oid = 'TEST' + Math.random().toString(36).slice(2);
			const uid = '1';
			const amount = 1.23;
			const redirectUrl = await createOrder(oid, uid, amount, env);
			if (redirectUrl) {
				// send 302 redirect
				return Response.redirect(redirectUrl);
			} else {
				return new Response('Create order failed');
			}

		} else if (url.pathname === '/notify') {
			// check the signature
			const data: NotifyRequest = await request.json();
			const result = await verifyNotify(data, env);
			if (result) {
				// log
				console.log('[notify] success ', data);
				return new Response('success');
			} else {
				// log
				console.log('[notify] failed ', data);
				return new Response('failed');
			}
		}
		return new Response('Hello World!');
	},
} satisfies ExportedHandler<Env>;
