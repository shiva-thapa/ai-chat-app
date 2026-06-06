import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { MongoClient } from 'mongodb';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import cookieParser from 'cookie-parser';
import 'dotenv/config';

const app = express();
const server = createServer(app);
const io = new Server(server);


// middleware

app.use(express.json());
app.use(express.urlencoded({ extended: true })); //to turn into javascript object
app.use(cookieParser());
app.use(express.static('public'));

//environment variables
const MONGO_URI = process.env.MONGO_URI;
const JWT_SECRET = process.env.JWT_SECRET || 'default-secret-change-me';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;


//mongodb setup
const client = new MongoClient(MONGO_URI);
let db, usersCollection, messagesCollection;

async function connectDB() {
  try {
    await client.connect();
    db = client.db('chat-application');
    usersCollection = db.collection('users');
    messagesCollection = db.collection('messages');
    console.log('connected permanently to MongoDB Cloud Database!');

  } catch (error) {
    console.error('Database connection failed:', error);
    process.exit(1);
  }
}

// AI Setup
const ai = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = ai.getGenerativeModel({ model: 'gemini-1.5-flash' });

//authentication routes

//register
app.post('/api/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!username || !email || !password) {
      return res.status(400).json({ error: 'All fields are required'});
    }
    const existing = await usersCollection.findOne({ $or: [{ email}, { username }]
    });
    if (existing) {
      return res.status(400).json({ error: 'User already exists' });

    }
 const hashedPassword = await bcrypt.hash(password, 10);
 await usersCollection.insertOne({
  username,
  email,
  password: hashedPassword,
  createdAt: new Date(),

 });
 res.status(201).json({ message: 'User registered successfully' });

  } catch (err) {
    res.status(500).json({ error: 'Regisyration failed' });
    
  }
});
//login
app.post('/api/login', async (req,res) => {
  try {
    const { email, password } = req.body;
    const user = await usersCollection.findOne({ email });
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });

    }
const isMatch = await bcrypt.compare(password, user.password);
if (!isMatch) {
  return res.status(401).json({ error: 'Invalid credentials' });

}
const token = jwt.sign(
  { userId: user._id, username: user.username },
  JWT_SECRET,
  { expiresIn: '7d' }
);
res.cookie('token', token, {
  httpOnly: true,
  secure: process.env.NODE_env === 'production',
  sameSite: 'lax',
  maxAge: 7*24*60*60*1000, //7 days

});
res.json({ user: { id: user._id, username: user.username, email: user.email } });


  } catch (err) {
    res.status(500).json({ error: 'Login failed' });

  }
});

//logout
app.post('/api/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ message: 'Logged out' });
});

//get current user from token
app.get('/api/me', (req, res) => 
{
 const token = req.cookies.token;
 if (!token) return  res.status(401).json({ error: 'Not authenticated' });
 try {
  const decoded = jwt.verify(token, JWT_SECRET);
  res.json({ user: decoded });

 } catch (err) {
  res.status(401).json({ error: 'Invalid token' });

 } 
});

//protected route: serve chat page only if logged in
app.get('/chat', (req, res) => {
  const token =req.cookies.token;
  if (!token) return res.redirect('/');
  try {
    jwt.verify(token, JWT_SECRET);
    res.sendFile(process.cwd() + '/public/chat.html');

  } catch (err) {
    res.redirect('/');
  }
})


//socket.io authentication middleware
io.use(async (socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('Authentication error'));
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    socket.userId = decoded.userId;
    socket.username = decoded.username;
    next();

  } catch (err) {
    next(new Error('Invalid token'));

  }
});

//socket.io events
io.on('connection', (socket) => {
  console.log(`User ${socket.username} connected`);

  socket.on('join room', async (roomnCode) => {
    socket.join(roomCode);
    socket.currentRoom = roomCode;
    console.log(`${socket.username} joined room: ${roomCode}`);

    try { 
      const hisytory = await messagesCollection
      .find({ room: roomCode })
      .sort({ timestamp: 1 })
      .toArray();

      history.forEach((msg) => {
        socket.emit('chat message', { user: msg.user, text: msg.text });

      });


    } catch (err) {
      console.error('Failed to load chat history:', err);

    }
  });

  socket.on('chat message', async (data) => {
    const room = socket.currentRoom;
    if (!room) return;

    //use authenticated username , ignore what the client sends
    const messageData = {
      room,
      user: socket.username,
      text: data.text,
      timestamp: new Date(),

    };

    try {
      await messagesCollection.insertOne(messageData);
      io.to(room).emit('chat message', {
        user: socket.username,
        text: data.text,
      });
    
    } catch (err) {
      console.error('Failed to save message:', err);

    }
  });

  socket.on('summarize', async () => {
    const room = socket.currentRoom;
    if (!room) return;
    
    try {
      const history = await messagesCollection
      .find({ room })
      .sort({ timestamp: 1 })
      .toArray();
      if(history.length === 0) return;

      const textHistory = history.map(msg => `${msg.user}: ${msg.text}`).join(' ');
      const prompt = `Summarize the followinchat room history in 2-3 sentences: ${textHistory}`;
      const result = await model.generateContent(prompt);
      const summary = result.response.text();

      io.to(room).emit('ai summary', summary);

    } catch (error) {
      console.error('Ai Error:', error);
      
    }
  });
});


//start server
async funtion startServer() {
  await connectDB();
  const PORT = process.env.PORT || 3000;
  server.listen(PORT,() => {
    console.log(`Server running on port ${PORT}`);
  });
}

startServer();

