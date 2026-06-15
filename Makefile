BINARY = moidhost

.PHONY: build clean run

build:
	go build -o $(BINARY) .

run: build
	./$(BINARY)

clean:
	rm -f $(BINARY)
