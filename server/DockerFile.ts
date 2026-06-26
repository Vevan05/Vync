FROM node:18-alpine
RUN npm install -g ts-node typescript
RUN echo '{"compilerOptions":{"module":"commonjs","target":"es2017","esModuleInterop":true}}' > /tsconfig.json
WORKDIR /code