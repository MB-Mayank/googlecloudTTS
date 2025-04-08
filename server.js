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

// WebSocket connection handling
const activeConnections = new Set();

wss.on('connection', (ws) => {
  console.log('Client connected');
  let sequenceNumber = 0;
  let processingQueue = [];
  let isProcessing = false;
  
  activeConnections.add(ws);
  
  // Process the next text in queue
  const processNextInQueue = async () => {
    if (processingQueue.length === 0 || isProcessing) {
      return;
    }
    
    isProcessing = true;
    const nextItem = processingQueue.shift();
    
    try {
      await synthesizeText(nextItem);
    } catch (error) {
      console.error('Error processing queued text:', error);
      ws.send(JSON.stringify({ 
        type: 'error', 
        message: error.message
      }));
    } finally {
      isProcessing = false;
      // Process next item if available
      if (processingQueue.length > 0) {
        processNextInQueue();
      }
    }
  };
  
  // Function to synthesize text to speech
  const synthesizeText = async (data) => {
    const { 
      text, 
      languageCode = 'en-IN', 
      ssmlGender = 'NEUTRAL', 
      name = 'en-IN-Journey-O'
    } = data;
    
    // Notify client about starting audio stream
    ws.send(JSON.stringify({
      type: 'audio-info',
      contentType: 'audio/l16;rate=24000'
    }));
    
    // Create streaming synthesis stream
    const stream = textToSpeechClient.streamingSynthesize();
    
    return new Promise((resolve, reject) => {
      // Handle streaming response data
      stream.on('data', (response) => {
        if (response.audioContent) {
          // Get the audio content as buffer
          const audioBuffer = Buffer.isBuffer(response.audioContent) 
            ? response.audioContent 
            : Buffer.from(response.audioContent);
          
          // Create a buffer to store the sequence number (4 bytes)
          const sequenceBuffer = Buffer.alloc(4);
          sequenceBuffer.writeInt32LE(sequenceNumber, 0);
          
          // Create a flag buffer for isLastChunk (1 byte: 0 = false, 1 = true)
          const flagBuffer = Buffer.alloc(1);
          flagBuffer.writeUInt8(0); // Not the last chunk
          
          // Combine all buffers: [4-byte sequence][1-byte flag][audio data]
          const combinedBuffer = Buffer.concat([
            sequenceBuffer,  // 4 bytes for sequence number
            flagBuffer,      // 1 byte for isLastChunk flag
            audioBuffer      // Remaining bytes for audio data
          ]);
          
          // Send the combined buffer
          ws.send(combinedBuffer, { binary: true });
          
          // Log for debugging
          console.log(`Sent audio chunk #${sequenceNumber}, size: ${audioBuffer.length} bytes`);
          
          // Increment sequence number for next chunk
          sequenceNumber++;
        }
      });
      
      // Handle end of stream
      stream.on('end', () => {
        // Send a final message with isLastChunk=true
        const sequenceBuffer = Buffer.alloc(4);
        sequenceBuffer.writeInt32LE(sequenceNumber, 0);
        
        const flagBuffer = Buffer.alloc(1);
        flagBuffer.writeUInt8(1); // Last chunk = true
        
        // Empty audio buffer for the final message
        const emptyAudioBuffer = Buffer.alloc(0);
        
        const finalBuffer = Buffer.concat([
          sequenceBuffer,
          flagBuffer,
          emptyAudioBuffer
        ]);
        
        // Send the final message
        ws.send(finalBuffer, { binary: true });
        
        // Also send a completion message
        ws.send(JSON.stringify({ type: 'audio-complete' }));
        
        console.log('Audio streaming complete');
        resolve();
      });
      
      // Handle streaming errors
      stream.on('error', (error) => {
        console.error('Streaming synthesis error:', error);
        ws.send(JSON.stringify({ 
          type: 'error', 
          message: error.message
        }));
        reject(error);
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
    });
  };
  
  ws.on('message', async (message) => {
    try {
      // Parse the incoming message
      const data = JSON.parse(message.toString());
      
      if (data.type === 'synthesize-streaming') {
        // Add to processing queue
        processingQueue.push(data);
        console.log(`Added new text to processing queue. Queue length: ${processingQueue.length}`);
        
        // Start processing if not already processing
        if (!isProcessing) {
          processNextInQueue();
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
    // Clear the processing queue for this connection
    processingQueue = [];
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