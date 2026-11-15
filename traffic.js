"use strict";
const { isIP } = require("node:net");
const MAX_COUNTER = (1n << 64n) - 1n;

function overhead(address) {
    if (typeof address !== 'string') return null;
    address = address.split("%", 1)[0];
    const family = isIP(address);
    if (family === 4) return 28n;
    if (family !== 6) return null;
    // Expand enough to recognize both dotted and hexadecimal mapped IPv4.
    let text = address.toLowerCase();
    if (text.includes(".")) {
        const cut = text.lastIndexOf(":");
        const b = text.slice(cut + 1).split(".").map(Number);
        text = text.slice(0, cut + 1) + ((b[0] << 8) | b[1]).toString(16) + ":" + ((b[2] << 8) | b[3]).toString(16);
    }
    const halves = text.split("::");
    const left = halves[0] ? halves[0].split(":") : [];
    const right = halves[1] ? halves[1].split(":") : [];
    const groups = halves.length === 1 ? left : [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
    return groups.slice(0, 5).every(g => parseInt(g, 16) === 0) && parseInt(groups[5], 16) === 65535 ? 28n : 48n;
}

class TrafficCounters {
    constructor() {
        this.sent = [0n, 0n, 0n];
        this.received = [0n, 0n, 0n];
        this.sendFailures = 0n;
        this.incomplete = false;
        this.pending = 0;
    }
    add(old, value) {
        const result = old + BigInt(value);
        if (result > MAX_COUNTER) { this.incomplete = true; return MAX_COUNTER; }
        return result;
    }
    record(direction, length, address) {
        const header = overhead(address);
        const values = this[direction];
        values[0] = this.add(values[0], 1n);
        values[1] = this.add(values[1], length);
        if (header === null) this.incomplete = true;
        else values[2] = this.add(values[2], BigInt(length) + header);
    }
    failedSend() { this.sendFailures = this.add(this.sendFailures, 1n); }
    snapshot() {
        const direction = values => Object.freeze({ datagrams: values[0], payloadBytes: values[1], ipBytes: values[2] });
        return Object.freeze({ sent: direction(this.sent), received: direction(this.received),
            sendFailures: this.sendFailures, incomplete: this.incomplete || this.pending !== 0 });
    }
}
module.exports = { TrafficCounters, MAX_COUNTER };
