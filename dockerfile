# Dockerfile

# 1. Use a standard Node.js 18 Alpine Linux image (good balance of size and compatibility)
FROM node:18-alpine

# 2. Set the working directory inside the container
WORKDIR /app

# 3. Copy package.json and package-lock.json (or yarn.lock) first
# This optimizes Docker layer caching - dependencies are only re-installed if these files change
COPY package.json package-lock.json* ./
# If using Yarn, use: COPY package.json yarn.lock ./

# 4. Install all dependencies using npm ci (clean install based on lock file)
# We need devDependencies here because 'npm run build' needs TypeScript etc.
RUN npm ci
# If using Yarn, use: RUN yarn install --frozen-lockfile

# 5. Copy the rest of your application code into the container
# This respects the .dockerignore file
COPY . .

# 6. Run the build command defined in your package.json (tsc)
# This creates the 'dist' folder inside the container image
RUN npm run build

# 7. Tell Docker the application listens on port 8080
EXPOSE 8080

# 8. Define the command to run when the container starts
# This executes the compiled JavaScript server file
CMD ["node", "dist/server.js"]