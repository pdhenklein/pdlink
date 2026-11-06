// Cliente MQTT 3.1.1 minimo sobre WebSocket (QoS 0, sem dependencias).
// Usado so para sinalizacao: textos de conexao e "quem esta ao vivo". O video nunca passa por aqui.

const enc = new TextEncoder();
const dec = new TextDecoder();

function varint(n: number) {
    const out: number[] = [];
    do {
        let b = n % 128;
        n = Math.floor(n / 128);
        if (n > 0) b |= 128;
        out.push(b);
    } while (n > 0);
    return out;
}

function str(s: string) {
    const b = enc.encode(s);
    return [b.length >> 8, b.length & 255, ...b];
}

function bin(b: Uint8Array) {
    return [b.length >> 8, b.length & 255, ...b];
}

function packet(header: number, body: number[] | Uint8Array) {
    const arr = Array.from(body);
    return new Uint8Array([header, ...varint(arr.length), ...arr]);
}

export interface Will {
    topic: string;
    payload: string;
    retain: boolean;
}

export type OnMessage = (topic: string, payload: string) => void;

export class MqttClient {
    private ws: WebSocket | null = null;
    private buf = new Uint8Array(0);
    private ping: any = null;
    private subs: { filter: string; cb: OnMessage; }[] = [];
    private packetId = 1;
    onClose: () => void = () => { };

    connect(url: string, clientId: string, will?: Will, timeoutMs = 8000): Promise<void> {
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(url, "mqtt");
            ws.binaryType = "arraybuffer";
            this.ws = ws;
            const timer = setTimeout(() => { reject(new Error("broker: tempo esgotado")); try { ws.close(); } catch { } }, timeoutMs);
            ws.onopen = () => {
                let flags = 0x02;
                const payload: number[] = [...str(clientId)];
                if (will) {
                    flags |= 0x04 | (will.retain ? 0x20 : 0);
                    payload.push(...str(will.topic), ...bin(enc.encode(will.payload)));
                }
                ws.send(packet(0x10, [...str("MQTT"), 4, flags, 0, 30, ...payload]));
            };
            ws.onerror = () => { clearTimeout(timer); reject(new Error("broker: nao conectou")); };
            ws.onclose = () => { clearInterval(this.ping); this.onClose(); };
            ws.onmessage = ev => {
                const chunk = new Uint8Array(ev.data as ArrayBuffer);
                const joined = new Uint8Array(this.buf.length + chunk.length);
                joined.set(this.buf);
                joined.set(chunk, this.buf.length);
                this.buf = joined;
                this.drain(code => {
                    clearTimeout(timer);
                    if (code === 0) {
                        this.ping = setInterval(() => this.raw(new Uint8Array([0xC0, 0])), 20000);
                        resolve();
                    } else reject(new Error("broker recusou a conexao: " + code));
                });
            };
        });
    }

    private drain(onConnack: (code: number) => void) {
        for (; ;) {
            if (this.buf.length < 2) return;
            let len = 0, mul = 1, i = 1, b: number;
            do {
                if (i >= this.buf.length) return;
                b = this.buf[i++];
                len += (b & 127) * mul;
                mul *= 128;
            } while (b & 128);
            if (this.buf.length < i + len) return;
            const header = this.buf[0];
            const body = this.buf.slice(i, i + len);
            this.buf = this.buf.slice(i + len);
            const type = header >> 4;
            if (type === 2) onConnack(body[1]);
            else if (type === 3) this.onPublish(header, body);
        }
    }

    private onPublish(header: number, body: Uint8Array) {
        const tl = (body[0] << 8) | body[1];
        const topic = dec.decode(body.slice(2, 2 + tl));
        let off = 2 + tl;
        if (((header >> 1) & 3) > 0) off += 2;
        const payload = dec.decode(body.slice(off));
        for (const s of this.subs) if (matches(s.filter, topic)) s.cb(topic, payload);
    }

    private raw(p: Uint8Array) {
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(p);
    }

    subscribe(filter: string, cb: OnMessage) {
        this.subs.push({ filter, cb });
        const id = this.packetId++ & 0xffff;
        this.raw(packet(0x82, [id >> 8, id & 255, ...str(filter), 0]));
    }

    publish(topic: string, payload: string, retain = false) {
        this.raw(packet(0x30 | (retain ? 1 : 0), [...str(topic), ...enc.encode(payload)]));
    }

    close() {
        clearInterval(this.ping);
        try { this.raw(new Uint8Array([0xE0, 0])); this.ws?.close(); } catch { }
        this.ws = null;
    }
}

function matches(filter: string, topic: string) {
    const f = filter.split("/");
    const t = topic.split("/");
    for (let i = 0; i < f.length; i++) {
        if (f[i] === "#") return true;
        if (i >= t.length) return false;
        if (f[i] !== "+" && f[i] !== t[i]) return false;
    }
    return f.length === t.length;
}
