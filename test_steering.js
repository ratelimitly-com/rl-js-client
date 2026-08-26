#!/usr/bin/env node
'use strict';

const assert = require('assert');
const dgram = require('dgram');
const os = require('os');
const {
  STEERING_PORT_MIN,
  STEERING_PORT_MAX,
  STEERING_PORT_COUNT,
  nextSteeringPort,
  createBoundUdpSocket,
  bindNextSteeringSocket
} = require('./steering');

class FakeSocket {
  constructor(occupiedPort) {
    this.occupiedPort = occupiedPort;
    this.bound = null;
    this.closed = false;
    this.listeners = new Map();
  }

  once(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(fn);
  }

  removeListener(event, fn) {
    const list = this.listeners.get(event) || [];
    this.listeners.set(event, list.filter((f) => f !== fn));
  }

  removeAllListeners() {
    this.listeners.clear();
  }

  bind(options, cb) {
    if (options.port === this.occupiedPort) {
      const err = new Error('occupied');
      err.code = 'EADDRINUSE';
      const errorListeners = this.listeners.get('error') || [];
      for (const fn of errorListeners) fn(err);
      return;
    }
    this.bound = options;
    if (typeof cb === 'function') process.nextTick(cb);
  }

  close() {
    this.closed = true;
  }
}

async function testPortProgressionAndWrap() {
  console.log('Testing monotonic progression and wrap...');
  assert.strictEqual(nextSteeringPort(STEERING_PORT_MIN), STEERING_PORT_MIN + 1);
  assert.strictEqual(nextSteeringPort(65534), 65535);
  assert.strictEqual(nextSteeringPort(65535), STEERING_PORT_MIN);
  assert.strictEqual(nextSteeringPort(40000), STEERING_PORT_MIN);
  assert.strictEqual(nextSteeringPort(0), STEERING_PORT_MIN);
  console.log('✅ Port progression and wrap verified');
}

async function testOccupiedCandidateSkippingMock() {
  console.log('Testing occupied candidate skipping with mock...');
  const occupiedPort = 60000;
  const createdSockets = [];
  const factory = () => {
    const s = new FakeSocket(occupiedPort);
    createdSockets.push(s);
    return s;
  };

  const result = await bindNextSteeringSocket('udp4', occupiedPort, factory);
  assert.strictEqual(result.selectedPort, 60001);
  assert.strictEqual(result.nextPort, 60002);
  assert.strictEqual(createdSockets.length, 2);
  assert.strictEqual(createdSockets[0].closed, true);
  assert.strictEqual(createdSockets[1].bound.port, 60001);
  console.log('✅ Mock occupied candidate skipping verified');
}

async function testRealSpecificAddressCandidateSkipping() {
  console.log('Testing real candidate skipping with blocker socket...');
  // Find a free port and bind a blocker socket on it
  let blocker = null;
  let occupiedPort = null;

  for (let candidate = STEERING_PORT_MIN; candidate <= STEERING_PORT_MAX; candidate++) {
    try {
      blocker = await createBoundUdpSocket('udp4', candidate);
      occupiedPort = candidate;
      break;
    } catch (_) {
      // Try next
    }
  }

  assert(blocker && occupiedPort, 'Must bind a blocker socket');

  try {
    const result = await bindNextSteeringSocket('udp4', occupiedPort);
    try {
      assert.notStrictEqual(result.selectedPort, occupiedPort, 'Should skip occupied port');
      assert.strictEqual(result.nextPort, nextSteeringPort(result.selectedPort));
      assert(result.selectedPort >= STEERING_PORT_MIN && result.selectedPort <= STEERING_PORT_MAX);
    } finally {
      result.socket.close();
    }
  } finally {
    blocker.close();
  }

  console.log('✅ Real candidate skipping verified');
}

async function run() {
  try {
    await testPortProgressionAndWrap();
    await testOccupiedCandidateSkippingMock();
    await testRealSpecificAddressCandidateSkipping();
    console.log('🎉 All steering unit tests passed!');
  } catch (err) {
    console.error('❌ Steering test failed:', err);
    process.exit(1);
  }
}

run();
