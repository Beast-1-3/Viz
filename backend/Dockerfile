# Use Node.js LTS as the base image
FROM node:20-slim

# Create app directory
WORKDIR /usr/src/app

# Install app dependencies
COPY package*.json ./
RUN npm install --production

# Bundle app source
COPY . .

# Create storage directories
RUN mkdir -p CloudConnect-Vault/Incomplete CloudConnect-Vault/Ready

# Expose the port the app runs on
EXPOSE 5001

# Command to run the application
CMD [ "node", "index.js" ]
