import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { MongoClient, ObjectId } from 'mongodb';
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
let db, usersCollection, messagesCollection, roomsCollection,
    conversationsCollection, directMessagesCollection,
    friendRequestsCollection, friendsCollection;

async function connectDB() {
  try {
    await client.connect();
    db = client.db('chat-application');   // use your actual DB name
    usersCollection = db.collection('users');
    messagesCollection = db.collection('messages');
    roomsCollection = db.collection('rooms');
    conversationsCollection = db.collection('conversations');
    directMessagesCollection = db.collection('direct_messages');
    friendRequestsCollection = db.collection('friend_requests');
    friendsCollection = db.collection('friends');
    console.log('✅ Connected permanently to MongoDB Cloud Database!');
    // Indices
    await roomsCollection.createIndex({ roomCode: 1 }, { unique: true });
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

// ---------- Room API Routes ----------
app.post('/api/rooms', async (req, res) => {
  try {
    const { roomCode, roomName } = req.body;
    if (!roomCode) return res.status(400).json({ error: 'Room code required' });
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
      createdAt: new Date()
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
    if (!room) return res.status(404).json({ error: 'Room not found' });
    if (!room.members.includes(username)) {
      await roomsCollection.updateOne(
        { roomCode },
        { $addToSet: { members: username } }
      );
    }
    res.json({ message: 'Joined room', roomCode });
  } catch (err) {
    console.error('Join room error:', err);
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

// ---------- User list (for DM – now filtered) ----------
app.get('/api/users', async (req, res) => {
  try {
    const token = req.cookies.token;
    if (!token) return res.status(401).json({ error: 'Not authenticated' });
    const decoded = jwt.verify(token, JWT_SECRET);
    const username = decoded.username;

    // Get all users except self
    const allUsers = await usersCollection.find({}, { projection: { username: 1, _id: 0 } }).toArray();
    const otherUsernames = allUsers.filter(u => u.username !== username).map(u => u.username);

    // Exclude already friends or pending requests
    const friendships = await friendsCollection.find({ users: username }).toArray();
    const friendSet = new Set(friendships.flatMap(f => f.users));
    const pendingRequests = await friendRequestsCollection.find({
      $or: [{ from: username }, { to: username }],
      status: 'pending'
    }).toArray();
    const pendingSet = new Set(pendingRequests.flatMap(r => [r.from, r.to]));

    const available = otherUsernames.filter(u => !friendSet.has(u) && !pendingSet.has(u));
    res.json({ users: available });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---------- Conversations (DM) API ----------
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

app.post('/api/conversations', async (req, res) => {
  try {
    const token = req.cookies.token;
    if (!token) return res.status(401).json({ error: 'Not authenticated' });
    const decoded = jwt.verify(token, JWT_SECRET);
    const currentUser = decoded.username;
    const { participant } = req.body;
    if (!participant || participant === currentUser) return res.status(400).json({ error: 'Invalid participant' });

    // Check that they are friends (new restriction)
    const areFriends = await friendsCollection.findOne({
      users: { $all: [currentUser, participant] }
    });
    if (!areFriends) return res.status(403).json({ error: 'You must be friends to start a conversation' });

    const otherUser = await usersCollection.findOne({ username: participant });
    if (!otherUser) return res.status(404).json({ error: 'User not found' });

    const participants = [currentUser, participant].sort();
    const conversationId = participants.join('_');

    const existing = await conversationsCollection.findOne({ conversationId });
    if (existing) return res.json({ conversationId });

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

// ---------- Friend System API ----------
// Send friend request
app.post('/api/friend-request', async (req, res) => {
  try {
    const token = req.cookies.token;
    if (!token) return res.status(401).json({ error: 'Not authenticated' });
    const decoded = jwt.verify(token, JWT_SECRET);
    const from = decoded.username;
    const { to } = req.body;
    if (!to || to === from) return res.status(400).json({ error: 'Invalid recipient' });

    const recipient = await usersCollection.findOne({ username: to });
    if (!recipient) return res.status(404).json({ error: 'User not found' });

    const alreadyFriends = await friendsCollection.findOne({ users: { $all: [from, to] } });
    if (alreadyFriends) return res.status(400).json({ error: 'Already friends' });

    const existingRequest = await friendRequestsCollection.findOne({ from, to, status: 'pending' });
    if (existingRequest) return res.status(400).json({ error: 'Friend request already sent' });

    await friendRequestsCollection.insertOne({ from, to, status: 'pending', createdAt: new Date() });

    // Real-time notification to recipient if online
    io.to(to).emit('friend request', { from, message: `${from} sent you a friend request` });

    res.status(201).json({ message: 'Friend request sent' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get pending requests for current user
app.get('/api/friend-requests', async (req, res) => {
  try {
    const token = req.cookies.token;
    if (!token) return res.status(401).json({ error: 'Not authenticated' });
    const decoded = jwt.verify(token, JWT_SECRET);
    const username = decoded.username;
    const requests = await friendRequestsCollection.find({ to: username, status: 'pending' }).toArray();
    res.json({ requests });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Accept or reject a friend request
app.post('/api/friend-request/:id', async (req, res) => {
  try {
    const token = req.cookies.token;
    if (!token) return res.status(401).json({ error: 'Not authenticated' });
    const decoded = jwt.verify(token, JWT_SECRET);
    const username = decoded.username;
    const { id } = req.params;
    const { action } = req.body; // 'accept' or 'reject'

    const request = await friendRequestsCollection.findOne({
      _id: new ObjectId(id),
      to: username,
      status: 'pending'
    });
    if (!request) return res.status(404).json({ error: 'Request not found' });

    if (action === 'accept') {
      await friendRequestsCollection.updateOne({ _id: request._id }, { $set: { status: 'accepted' } });
      await friendsCollection.insertOne({
        users: [request.from, request.to],
        createdAt: new Date()
      });
      io.to(request.from).emit('friend request accepted', { from: username });
      res.json({ message: 'Friend request accepted' });
    } else if (action === 'reject') {
      await friendRequestsCollection.updateOne({ _id: request._id }, { $set: { status: 'rejected' } });
      res.json({ message: 'Friend request rejected' });
    } else {
      return res.status(400).json({ error: 'Invalid action' });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get friends list
app.get('/api/friends', async (req, res) => {
  try {
    const token = req.cookies.token;
    if (!token) return res.status(401).json({ error: 'Not authenticated' });
    const decoded = jwt.verify(token, JWT_SECRET);
    const username = decoded.username;
    const friendships = await friendsCollection.find({ users: username }).toArray();
    const friends = friendships.map(f => f.users.find(u => u !== username));
    res.json({ friends });
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

// Online presence tracking
const onlineUsers = new Map(); // username -> socket.id

// ---------- Socket.io Events ----------
io.on('connection', (socket) => {
  console.log(`User ${socket.username} connected`);
  onlineUsers.set(socket.username, socket.id);

  // Notify friends that user is online
  (async () => {
    const friendships = await friendsCollection.find({ users: socket.username }).toArray();
    friendships.forEach(f => {
      const friend = f.users.find(u => u !== socket.username);
      io.to(friend).emit('friend status', { username: socket.username, online: true });
    });
  })();

  // ---- Room events ----
  socket.on('join room', async (roomCode) => {
    if (!roomCode) return;
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
    if (socket.currentRoom) socket.leave(socket.currentRoom);
    socket.join(roomCode);
    socket.currentRoom = roomCode;
    socket.currentConversation = null;
    console.log(`${username} joined room: ${roomCode}`);

    try {
      const history = await messagesCollection
        .find({ room: roomCode })
        .sort({ timestamp: 1 })
        .toArray();
      history.forEach(msg => socket.emit('chat message', { user: msg.user, text: msg.text }));
    } catch (err) {
      console.error('Failed to load chat history:', err);
    }
  });

  socket.on('chat message', async (data) => {
    const room = socket.currentRoom;
    if (!room) return;
    const messageData = {
      room,
      user: socket.username,
      text: data.text,
      timestamp: new Date()
    };
    try {
      await messagesCollection.insertOne(messageData);
      io.to(room).emit('chat message', { user: socket.username, text: data.text });
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
      if (history.length === 0) return;
      const textHistory = history.map(msg => `${msg.user}: ${msg.text}`).join(' ');
      const prompt = `Summarize the following chat room history in 2-3 sentences: ${textHistory}`;
      const result = await model.generateContent(prompt);
      const summary = result.response.text();
      io.to(room).emit('ai summary', summary);
    } catch (error) {
      console.error('AI Error:', error);
    }
  });

  // ---- Direct Messages ----
  socket.on('join conversation', async (conversationId) => {
    if (!conversationId) return;
    const conv = await conversationsCollection.findOne({ conversationId });
    if (!conv || !conv.participants.includes(socket.username)) {
      socket.emit('error', 'Not a member of this conversation');
      return;
    }
    if (socket.currentRoom) socket.leave(socket.currentRoom);
    if (socket.currentConversation) socket.leave(socket.currentConversation);

    socket.join(conversationId);
    socket.currentConversation = conversationId;
    socket.currentRoom = null;
    console.log(`${socket.username} joined DM: ${conversationId}`);

    try {
      const history = await directMessagesCollection
        .find({ conversationId })
        .sort({ timestamp: 1 })
        .toArray();
      history.forEach(msg => socket.emit('direct message', {
        conversationId,
        sender: msg.sender,
        text: msg.text
      }));
    } catch (err) {
      console.error('Failed to load DM history:', err);
    }
  });

  socket.on('direct message', async (data) => {
    const conversationId = data.conversationId;
    if (!conversationId || !data.text) return;
    if (socket.currentConversation !== conversationId) return;

    const msgData = {
      conversationId,
      sender: socket.username,
      text: data.text,
      timestamp: new Date()
    };
    try {
      await directMessagesCollection.insertOne(msgData);
      await conversationsCollection.updateOne(
        { conversationId },
        { $set: { lastMessage: data.text, lastMessageTimestamp: new Date() } }
      );
      io.to(conversationId).emit('direct message', {
        conversationId,
        sender: socket.username,
        text: data.text
      });
    } catch (err) {
      console.error('Failed to save DM:', err);
    }
  });

  // Disconnect
  socket.on('disconnect', async () => {
    console.log(`User ${socket.username} disconnected`);
    onlineUsers.delete(socket.username);
    // Notify friends that user is offline
    const friendships = await friendsCollection.find({ users: socket.username }).toArray();
    friendships.forEach(f => {
      const friend = f.users.find(u => u !== socket.username);
      io.to(friend).emit('friend status', { username: socket.username, online: false });
    });
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