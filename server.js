import express from 'express';
import cors from 'cors';
import http from 'http';
import { WebSocketServer } from 'ws';
import { v1 as textToSpeech } from '@google-cloud/text-to-speech';

const app = express();
const port = process.env.PORT || 3001;
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Middleware
app.use(cors());
app.use(express.json());

const textToSpeechClient = new textToSpeech.TextToSpeechClient();

// Regular text-to-speech endpoint
app.post('/api/synthesize', async (req, res) => {
  try {
    const { 
      text, 
      languageCode = 'en-US', 
      ssmlGender = 'NEUTRAL',
      name = 'en-US-Standard-A',
      audioEncoding = 'MP3' 
    } = req.body;

    const request = {
      input: { text },
      voice: { languageCode, ssmlGender, name },
      audioConfig: { audioEncoding },
    };

    const [response] = await textToSpeechClient.synthesizeSpeech(request);
    
    res.set('Content-Type', 'audio/mp3');
    res.set('Content-Length', response.audioContent.length);
    res.send(response.audioContent);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// WebSocket connection handling
wss.on('connection', (ws) => {
  console.log('Client connected');
  
  ws.on('message', async (message) => {
    try {
      // Parse the incoming message
      const data = JSON.parse(message.toString());
      
      if (data.type === 'synthesize-streaming') {
        const { 
          text, 
          languageCode = 'en-IN', 
          ssmlGender = 'NEUTRAL', 
          name = 'en-IN-Journey-O',
          audioEncoding = 'MP3' 
        } = data;

        // Create a streaming synthesis request
        const request = {
          input: { text },
          voice: { languageCode, ssmlGender, name },
          audioConfig: { audioEncoding },
        };

        try {
          // Notify client about starting audio stream
          ws.send(JSON.stringify({
            type: 'audio-info',
            contentType: 'audio/mp3'
          }));

          // Use synthesizeSpeech but directly forward chunks as they come
          const [response] = await textToSpeechClient.synthesizeSpeech(request);
          
          // Instead of slicing and delaying, send directly to client
          ws.send(response.audioContent);

          // Signal that audio streaming is complete
          ws.send(JSON.stringify({ type: 'audio-complete' }));
        } catch (error) {
          console.error('Streaming synthesis error:', error);
          ws.send(JSON.stringify({ 
            type: 'error', 
            message: error.message 
          }));
        }
      }
    } catch (error) {
      console.error('Message processing error:', error);
      ws.send(JSON.stringify({ 
        type: 'error', 
        message: error.message 
      }));
    }
  });
  
  ws.on('close', () => {
    console.log('Client disconnected');
  });
});

app.get('/', (req, res) => {
  res.send('Server is running');
});

server.listen(port, () => {
  console.log(`Server running with WebSockets on port ${port}`);
});