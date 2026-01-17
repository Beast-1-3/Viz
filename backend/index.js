const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const uploadRoutes = require('./routes/upload');
const startCleanupJob = require('./utils/cleanup');
const chaosMiddleware = require('./middleware/chaos');

const app = express();
const PORT = process.env.PORT || 5001;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(chaosMiddleware); // Injected chaos monkey

// Routes
app.use('/api/upload', uploadRoutes);

// Static Files (for completed downloads)
app.use('/vault', express.static(path.join(__dirname, 'CloudConnect-Vault')));

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB Connected'))
  .catch(err => {
    console.error('❌ MongoDB Connection Error:', err.message);
    process.exit(1);
  });

// Basic Route
app.get('/', (req, res) => {
  res.json({ message: 'Large File Upload System API is running' });
});

// Start Server
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  startCleanupJob();
});
