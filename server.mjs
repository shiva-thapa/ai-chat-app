import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { MongoClient } from 'mongodb';
import 'dotenv/config';

const app = express();
const server = createServer(app);
const io = new Server(server);

// AI Setup
const ai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = ai.getGenerativeModel({ model: 'gemini-1.5-flash' });

// MongoDB Setup
const client = new MongoClient(process.env.MONGO_URI);
let messagesCollection; // will be set after DB connection

app.use(express.static('public'));

async function startServer() {
  try {
    await client.connect();
    console.log('✅ Connected permanently to MongoDB Cloud Database!');
    const database = client.db('chat_application');
    messagesCollection = database.collection('messages');

    // Only start listening after DB is ready
    server.listen(3000, () => {
      console.log('🚀 Server running on http://localhost:3000');
    });
  } catch (error) {
    console.error('❌ Database connection failed:', error);
    process.exit(1); // Stop if DB isn't connected
  }
}

io.on('connection', (socket) => {
  socket.on('join room', async (roomCode) => {
    socket.join(roomCode);
    socket.currentRoom = roomCode;
    console.log(`User joined room: ${roomCode}`);

    // Load history
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

    const messageData = {
      room,
      user: data.user,
      text: data.text,
      timestamp: new Date(),
    };

    try {
      await messagesCollection.insertOne(messageData);
      // Broadcast to all in the room (including sender)
      io.to(room).emit('chat message', data);
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
});

startServer();