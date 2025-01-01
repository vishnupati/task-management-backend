require('dotenv').config();
const express = require('express');
const app = express();
const cors = require('cors');
const port = process.env.PORT || 3000;
const taskRoutes = require('./routes/task');
const connectDB = require('./config/db'); 
connectDB();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());
app.use('/api/tasks', taskRoutes);
app.get('/', (req, res) => {
    res.send('Hello World');
});

app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});



