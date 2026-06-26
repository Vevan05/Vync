FROM golang:1.21-alpine
RUN mkdir /warmup
WORKDIR /warmup
RUN printf 'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("ok")\n}\n' > main.go
RUN go run main.go
WORKDIR /code