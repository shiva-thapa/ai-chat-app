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

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static('public'));

// Environment variables
const MONGO_URI = process.env.MONGO_URI;
const JWT_SECRET = process.env.JWT_SECRET || 'default-secret-change-me';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// MongoDB Setup
const client = new MongoClient(MONGO_URI);
let db, usersCollection, messagesCollection, roomsCollection, conversationsCollection, directMessagesCollection;

async function connectDB() {
  try {
    await client.connect();
    db = client.db('chat-application');   // use your actual DB name
    usersCollection = db.collection('users');
    messagesCollection = db.collection('messages');
    roomsCollection = db.collection('rooms');
    conversationsCollection = db.collection('conversations');
    directMessagesCollection = db.collection('direct_messages');
    console.log('✅ Connected permanently to MongoDB Cloud Database!');
    // Index for conversations (optional)
    await conversationsCollection.createIndex({ conversationId: 1 }, { unique: true });
  } catch (error) {
    console.error('❌ Database connection failed:', error);
    process.exit(1);
  }
}

// AI Setup
const ai = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = ai.getGenerativeModel({ model: 'gemini-1.5-flash' });

// ---------- Authentication Routes ----------
app.post('/api/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!username || !email || !password) return res.status(400).json({ error: 'All fields required' });
    const existing = await usersCollection.findOne({ $or: [{ email }, { username }] });
    if (existing) return res.status(400).json({ error: 'User already exists' });
    const hashedPassword = await bcrypt.hash(password, 10);
    await usersCollection.insertOne({ username, email, password: hashedPassword, createdAt: new Date() });
    res.status(201).json({ message: 'User registered successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await usersCollection.findOne({ email });
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ userId: user._id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000
    });
    res.json({ user: { id: user._id, username: user.username, email: user.email } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ message: 'Logged out' });
});

app.get('/api/me', (req, res) => {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    res.json({ user: decoded });
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
});

app.get('/chat', (req, res) => {
  const token = req.cookies.token;
  if (!token) return res.redirect('/');
  try {
    jwt.verify(token, JWT_SECRET);
    res.sendFile(process.cwd() + '/public/chat.html');
  } catch (err) {
    res.redirect('/');
  }
});

// ---------- Room API Routes (unchanged) ----------
app.post('/api/rooms', async (req, res) => { 
  try {
    const { roomCode, roomName } = req.body;
    if (!roomCode) return res.status(400).json({ error: 'Room code required'});

    const existing = await roomsCollection.findOne({ roomCode });
    if (existing) return res.status(400).json({ error: 'Room already exists' });

    const token = req.cookies.token;
    if (!token) return res.status(401).json({ error: 'Not authenticated' });
    const decoded = jwt.verify(token, JWT_SECRET);
    const creator = decoded.username;

    await roomsCollection.insertOne({
      roomCode,
      roomName: roomName || roomCode,
      creator,
      members: [creator],
      createdAt: new Date(),

    });

    res.status(201).json({ message: 'Room created' });
      } catch (err) {
        console.error('Room creation error:', err);
        res.status(500).json({ error: 'Server error' });

      }
 });
app.post('/api/rooms/:roomCode/join', async (req, res) => { 
  try {
    const { roomCode } = req.params;
    const token = req.cookies.token;
    if (!token) return res.status(401).json({ error: 'Not authenticated' });
    const decoded = jwt.verify(token, JWT_SECRET);
    const username = decoded.username;
  
  const room = await roomsCollection.findOne({ roomCode });
  if(!room) return res.status(404).json({ error: 'Room not found' });

  if(!room.members.includes(username)) {
    await roomsCollection.updateOne(
      { roomCode },
      { $addToSet: { members: username } }
    );
  }
  res.json({ message: 'Joined room', roomCode });

  } catch (err) {
    console.error('Join room error', err);
    res.status(500).json({ error: 'Server error' });

  }
 });
app.get('/api/rooms', async (req, res) => { 
  try {
    const token = req.cookies.token;
    if (!token) return res.status(401).json({ error: 'Not authenticated' });
    const decoded = jwt.verify(token, JWT_SECRET);
    const username = decoded.username;

    const rooms = await roomsCollection.find({ members: username }).toArray();
    res.json({ rooms });

  } catch (err) {
    console.error('List rooms error:', err);
    res.status(500).json({ error: 'Server error' });

  }
 });

// ---------- NEW: User list (for DM) ----------
app.get('/api/users', async (req, res) => {
  try {
    const token = req.cookies.token;
    if (!token) return res.status(401).json({ error: 'Not authenticated' });
    const decoded = jwt.verify(token, JWT_SECRET);
    const users = await usersCollection.find({}, { projection: { username: 1, _id: 0 } }).toArray();
    // Exclude self
    const otherUsers = users.filter(u => u.username !== decoded.username).map(u => u.username);
    res.json({ users: otherUsers });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---------- Conversations (DM) API ----------
// Get conversations for current user
app.get('/api/conversations', async (req, res) => {
  try {
    const token = req.cookies.token;
    if (!token) return res.status(401).json({ error: 'Not authenticated' });
    const decoded = jwt.verify(token, JWT_SECRET);
    const username = decoded.username;
    const convs = await conversationsCollection.find({ participants: username }).toArray();
    res.json({ conversations: convs });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Start a new conversation or get existing one
app.post('/api/conversations', async (req, res) => {
  try {
    const token = req.cookies.token;
    if (!token) return res.status(401).json({ error: 'Not authenticated' });
    const decoded = jwt.verify(token, JWT_SECRET);
    const currentUser = decoded.username;
    const { participant } = req.body;
    if (!participant || participant === currentUser) return res.status(400).json({ error: 'Invalid participant' });

    // Ensure the other user exists
    const otherUser = await usersCollection.findOne({ username: participant });
    if (!otherUser) return res.status(404).json({ error: 'User not found' });

    // Generate a unique conversation ID (sorted usernames)
    const participants = [currentUser, participant].sort();
    const conversationId = participants.join('_');   // e.g., "alice_bob"

    const existing = await conversationsCollection.findOne({ conversationId });
    if (existing) {
      return res.json({ conversationId });
    }

    await conversationsCollection.insertOne({
      conversationId,
      participants,
      createdAt: new Date()
    });
    res.json({ conversationId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---------- Socket.io Auth Middleware ----------
io.use(async (socket, next) => {
  const rawCookies = socket.handshake.headers.cookie || '';
  const cookies = rawCookies.split(';').map(c => c.trim());
  const tokenCookie = cookies.find(row => row.startsWith('token='));
  if (!tokenCookie) return next(new Error('Authentication error'));
  const token = tokenCookie.split('=')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    socket.userId = decoded.userId;
    socket.username = decoded.username;
    next();
  } catch (err) {
    next(new Error('Invalid token'));
  }
});

// ---------- Socket.io Events ----------
io.on('connection', (socket) => {
  console.log(`User ${socket.username} connected`);

  // ---- Room events (unchanged) ----
  socket.on('join room', async (roomCode) => { 
     if (!roomCode) return;

    //check if room exists, auto-join if user not a member
    const room = await roomsCollection.findOne({ roomCode });
    if (!room) {
      socket.emit('error', 'Room not found');
      return;

    }
    
    const username = socket.username;
    if (!room.members.includes(username)) {
      await roomsCollection.updateOne(
        { roomCode },
        { $addToSet: { members: username } }

      );
    }


    //leave previous room(s) if any
    if (socket.currentRoom) {
      socket.leave(socket.currentRoom);
      
    }
    
    socket.join(roomCode);
    socket.currentRoom = roomCode;
    console.log(`${username} joined room: ${roomCode}`);


    //send history
    try { 
      const history = await messagesCollection
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

  // ---- NEW: Direct Messages ----
  socket.on('join conversation', async (conversationId) => {
    if (!conversationId) return;
    // Verify user is a participant
    const conv = await conversationsCollection.findOne({ conversationId });
    if (!conv || !conv.participants.includes(socket.username)) {
      socket.emit('error', 'Not a member of this conversation');
      return;
    }

    // Leave previous room(s) if any
    if (socket.currentRoom) socket.leave(socket.currentRoom);
    // Leave previous DM conversation if any (we track it manually)
    if (socket.currentConversation) socket.leave(socket.currentConversation);

    socket.join(conversationId);
    socket.currentConversation = conversationId;
    socket.currentRoom = null;   // clear room context
    console.log(`${socket.username} joined DM: ${conversationId}`);

    // Load DM history
    try {
      const history = await directMessagesCollection
        .find({ conversationId })
        .sort({ timestamp: 1 })
        .toArray();
      history.forEach(msg => {
        socket.emit('direct message', {
          conversationId,
          sender: msg.sender,
          text: msg.text
        });
      });
    } catch (err) {
      console.error('Failed to load DM history:', err);
    }
  });

  socket.on('direct message', async (data) => {
    const conversationId = data.conversationId;
    if (!conversationId || !data.text) return;
    // Only send to the DM room if we are currently in it
    if (socket.currentConversation !== conversationId) return;

    const msgData = {
      conversationId,
      sender: socket.username,
      text: data.text,
      timestamp: new Date()
    };

    try {
      await directMessagesCollection.insertOne(msgData);
      // Update last message in conversations metadata
      await conversationsCollection.updateOne(
        { conversationId },
        { $set: { lastMessage: data.text, lastMessageTimestamp: new Date() } }
      );
      // Emit to both participants (the room includes both)
      io.to(conversationId).emit('direct message', {
        conversationId,
        sender: socket.username,
        text: data.text
      });
    } catch (err) {
      console.error('Failed to save DM:', err);
    }
  });

  // Clean up on disconnect
  socket.on('disconnect', () => {
    console.log(`User ${socket.username} disconnected`);
  });
});

// Error handling
process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err));
process.on('unhandledRejection', (reason, promise) => console.error('Unhandled Rejection at:', promise, 'reason:', reason));

// Start server
async function startServer() {
  await connectDB();
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
}
startServer();


