# Dockerfile

FROM node:18-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
# Install ALL dependencies
RUN npm ci
COPY . .
# Step 6: Build the code (creates dist/)
RUN npm run build
# Step 7: Expose port
EXPOSE 8080
# Step 8: Command to run when container STARTS
CMD ["node", "dist/server.js"]
