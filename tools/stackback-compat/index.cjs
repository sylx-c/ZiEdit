'use strict';
// Copyright (c) 2026 ZiEdit Contributors. MIT; see LICENSE.
// Original adapter using the documented V8 Error.prepareStackTrace API.
module.exports = function structuredStack(error) {
  if (!(error instanceof Error)) return [];
  const original = Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace');
  try {
    Object.defineProperty(Error, 'prepareStackTrace', {
      configurable: true, writable: true, value: (_error, callsites) => callsites,
    });
    const frames = error.stack;
    return Array.isArray(frames) ? frames : [];
  } finally {
    if (original) Object.defineProperty(Error, 'prepareStackTrace', original);
    else delete Error.prepareStackTrace;
  }
};
