require('dotenv').config();
const express = require('express');
const app = express();
const cors = require('cors');
const cookieParser = require('cookie-parser');
const port = process.env.PORT || 3000;
const taskRoutes = require('./routes/task');
const authRoutes = require('./routes/auth');
const connectDB = require('./config/db');
const runConsumer = require('./workers/event-consumer').runConsumer; // Import consumer
connectDB();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(cors({
    origin: true,
    credentials: true,
}));
app.use('/api/auth', authRoutes);
app.use('/api/tasks', taskRoutes);
app.get('/', (req, res) => {
    res.send('Hello World');
});

app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
    // Start Kafka consumer
    runConsumer().catch(console.error);
});



