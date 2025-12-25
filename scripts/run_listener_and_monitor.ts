#!/usr/bin/env ts-node
// Run the Helius WS listener and the live monitor in the same process
// so they share the in-memory aggregator exported by `src/ledgerWindowAggregator`.

// Load environment variables from .env when present
try{ require('dotenv').config(); }catch(e){}

// Optional overrides (defaults):
process.env.MONITOR_INTERVAL_MS = process.env.MONITOR_INTERVAL_MS || '2000';
process.env.MONITOR_DURATION_MS = process.env.MONITOR_DURATION_MS || '600000';

// Ensure we're running from project root
const path = require('path');

// Start the WS listener (this file self-starts on require)
require(path.join(__dirname, 'helius_ws_listener'));

// Start the monitor (this file self-starts on require)
require(path.join(__dirname, 'live_monitor_mint'));
