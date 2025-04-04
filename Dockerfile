FROM node:22-slim

WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install --production

# Copy application code
COPY . .

# The port your app runs on
ENV PORT=3001

# Command to run the application
CMD ["node", "server.js"]