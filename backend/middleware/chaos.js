/**
 * Chaos Middleware for simulating failure scenarios
 */
const chaosMiddleware = (req, res, next) => {
    // Toggle chaos mode via header or env
    const chaosEnabled = process.env.ENABLE_CHAOS === 'true' || req.headers['x-chaos-mode'] === 'true';

    if (!chaosEnabled) return next();

    // 1. Simulate Random Chunk Failures (15% chance)
    if (req.path === '/chunk' && Math.random() < 0.15) {
        console.log('💥 [CHAOS]: Simulating random chunk failure.');
        return res.status(500).json({ error: 'Chaos Monkey: Random disk failure simulation' });
    }

    // 2. Simulate Network Latency (variable)
    const delay = Math.random() * 2000;
    setTimeout(next, delay);
};

module.exports = chaosMiddleware;


