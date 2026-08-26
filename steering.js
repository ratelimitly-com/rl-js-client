'use strict';

const dgram = require('dgram');

const STEERING_PORT_MIN = 49152;
const STEERING_PORT_MAX = 65535;
const STEERING_PORT_COUNT = STEERING_PORT_MAX - STEERING_PORT_MIN + 1; // 16384

/**
 * Advance monotonically once through the IANA dynamic/private port range (49152..65535).
 * Wraps to STEERING_PORT_MIN after 65535.
 *
 * @param {number} port Current port number
 * @returns {number} Next candidate port
 */
function nextSteeringPort(port) {
  if (typeof port !== 'number' || port < STEERING_PORT_MIN || port >= STEERING_PORT_MAX) {
    return STEERING_PORT_MIN;
  }
  return port + 1;
}

/**
 * Checks whether an error represents an occupied port condition (EADDRINUSE, EACCES, WSAEADDRINUSE, WSAEACCES).
 *
 * @param {Error|object} err Error object
 * @returns {boolean} True if occupied
 */
function isOccupiedError(err) {
  if (!err) return false;
  const code = err.code || err.errno;
  return code === 'EADDRINUSE' ||
    code === 'EACCES' ||
    code === 10048 || // WSAEADDRINUSE
    code === 10013;   // WSAEACCES
}

/**
 * Creates and exclusively binds a UDP socket to a wildcard address on the given port.
 * Uses exclusive: true for Windows SO_EXCLUSIVEADDRUSE isolation and clean Linux/macOS exclusivity.
 *
 * @param {'udp4'|'udp6'} family Socket family ('udp4' or 'udp6')
 * @param {number} port Port number to bind
 * @param {Function} [socketFactory] Optional custom socket factory
 * @returns {Promise<dgram.Socket>} Bound socket
 */
function createBoundUdpSocket(family, port, socketFactory) {
  return new Promise((resolve, reject) => {
    const type = family === 'udp6' ? 'udp6' : 'udp4';
    const address = type === 'udp6' ? '::' : '0.0.0.0';
    const socket = typeof socketFactory === 'function'
      ? socketFactory(type)
      : dgram.createSocket({ type });

    function onError(err) {
      socket.removeAllListeners();
      try {
        socket.close();
      } catch (_) {
        // Ignored
      }
      reject(err);
    }

    socket.once('error', onError);
    try {
      socket.bind({ port, address, exclusive: true }, () => {
        socket.removeListener('error', onError);
        resolve(socket);
      });
    } catch (err) {
      onError(err);
    }
  });
}

/**
 * Scans monotonically for the first available dynamic port starting from `firstPort`.
 * Skips occupied candidates across the dynamic port range (49152..65535).
 * Never falls back to port 0.
 *
 * @param {'udp4'|'udp6'} family Socket family
 * @param {number} firstPort Starting candidate port
 * @param {Function} [socketFactory] Optional custom socket factory
 * @returns {Promise<{ socket: dgram.Socket, selectedPort: number, nextPort: number }>}
 */
async function bindNextSteeringSocket(family, firstPort, socketFactory) {
  let candidate = (typeof firstPort === 'number' && firstPort >= STEERING_PORT_MIN && firstPort <= STEERING_PORT_MAX)
    ? firstPort
    : STEERING_PORT_MIN;

  let lastError = null;

  for (let i = 0; i < STEERING_PORT_COUNT; i++) {
    try {
      const socket = await createBoundUdpSocket(family, candidate, socketFactory);
      return {
        socket,
        selectedPort: candidate,
        nextPort: nextSteeringPort(candidate)
      };
    } catch (err) {
      if (!isOccupiedError(err)) {
        throw err;
      }
      lastError = err;
      candidate = nextSteeringPort(candidate);
    }
  }

  const err = new Error('no UDP source port is available for steering');
  err.code = 'EADDRINUSE';
  throw (lastError || err);
}

module.exports = {
  STEERING_PORT_MIN,
  STEERING_PORT_MAX,
  STEERING_PORT_COUNT,
  nextSteeringPort,
  isOccupiedError,
  createBoundUdpSocket,
  bindNextSteeringSocket
};
