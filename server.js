import express from 'express';
import cors from 'cors';
import http from 'http';
import { WebSocketServer } from 'ws';
import { v1beta1 as textToSpeechBeta } from '@google-cloud/text-to-speech';

const app = express();
const port = process.env.PORT || 3001;
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Middleware
app.use(cors());

// Create text-to-speech client using beta API for streaming
const textToSpeechClient = new textToSpeechBeta.TextToSpeechClient();

// Optional: Cache for frequently used text/responses
const audioCache = new Map();
const CACHE_MAX_SIZE = 100;

// WebSocket connection handling
const activeConnections = new Set();

wss.on('connection', (ws) => {
  console.log('Client connected');
  activeConnections.add(ws);
  
  ws.on('message', async (message) => {
    try {
      // Parse the incoming message
      const data = JSON.parse(message.toString());
      
      if (data.type === 'synthesize-streaming') {
        const { 
          text, 
          languageCode = 'en-IN', 
          ssmlGender = 'NEUTRAL', 
          name = 'en-IN-Journey-O'
        } = data;

        // Generate cache key - using LINEAR16 as the encoding format
        const cacheKey = `ws_${text}_${languageCode}_${ssmlGender}_${name}_LINEAR16`;
        
        // Check cache first
        if (audioCache.has(cacheKey)) {
          ws.send(JSON.stringify({
            type: 'audio-info',
            contentType: 'audio/l16;rate=24000',
            cached: true
          }));
          
          // Send the cached audio with a sequence number for ordering
          const cachedAudio = audioCache.get(cacheKey);
          ws.send(JSON.stringify({
            type: 'audio-chunk',
            sequenceNumber: 0,
            isLastChunk: true
          }));
          ws.send(cachedAudio);
          ws.send(JSON.stringify({ type: 'audio-complete' }));
          return;
        }

        try {
          // Notify client about starting audio stream
          ws.send(JSON.stringify({
            type: 'audio-info',
            contentType: 'audio/l16;rate=24000'
          }));

          // Create streaming synthesis stream
          const stream = textToSpeechClient.streamingSynthesize();
          
          // Collect audio chunks for caching
          const audioChunks = [];
          let sequenceNumber = 0;
          
          // Handle streaming response data
          stream.on('data', (response) => {
            if (response.audioContent) {
              // Send audio chunk with sequence information
              ws.send(JSON.stringify({
                type: 'audio-chunk',
                sequenceNumber: sequenceNumber,
                isLastChunk: false
              }));
              
              // Send the actual audio data
              ws.send(response.audioContent);
              
              // Store for caching
              audioChunks.push(response.audioContent);
              sequenceNumber++;
            }
          });
          
          // Handle end of stream
          stream.on('end', () => {
            // Signal that audio streaming is complete
            ws.send(JSON.stringify({ 
              type: 'audio-chunk',
              sequenceNumber: sequenceNumber,
              isLastChunk: true
            }));
            ws.send(JSON.stringify({ type: 'audio-complete' }));
            
            // Cache the complete audio if needed
            if (audioChunks.length > 0) {
              // Combine all chunks into a single Buffer
              const completeAudio = Buffer.concat(audioChunks);
              
              if (completeAudio.length < 1024 * 1024) {
                if (audioCache.size >= CACHE_MAX_SIZE) {
                  const firstKey = audioCache.keys().next().value;
                  audioCache.delete(firstKey);
                }
                audioCache.set(cacheKey, completeAudio);
              }
            }
          });
          
          // Handle streaming errors
          stream.on('error', (error) => {
            console.error('Streaming synthesis error:', error);
            ws.send(JSON.stringify({ 
              type: 'error', 
              message: error.message 
            }));
          });
          
          // Send streaming config in first request
          const streamingConfig = {
            streamingConfig: {
              voice: { 
                languageCode, 
                ssmlGender, 
                name 
              },
              audioConfig: { 
                audioEncoding: 'LINEAR16',
                sampleRateHertz: 24000
              }
            }
          };
          
          // Write streaming config to the stream
          stream.write(streamingConfig);
          
          // Send the input text in subsequent request
          const inputRequest = {
            input: { 
              text 
            }
          };
          
          // Write the input to the stream
          stream.write(inputRequest);
          
          // End the stream to signal we're done sending requests
          stream.end();
          
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
    activeConnections.delete(ws);
  });
});

// Simple health check endpoint
app.get('/', (req, res) => {
  res.send('Streaming TTS Server is running');
});

// Graceful shutdown handling
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

server.listen(port, () => {
  console.log(`Streaming TTS Server running on port ${port}`);
});