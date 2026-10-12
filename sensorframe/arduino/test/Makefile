# Desktop tests for the header-only library: make -C sensorframe/arduino/test
CXX ?= g++
CXXFLAGS ?= -std=c++11 -Wall -Wextra -Werror -O1 -fsanitize=address,undefined

run: native_test
	./native_test

native_test: native_test.cpp test_vectors.h ../src/*.h
	$(CXX) $(CXXFLAGS) -o $@ native_test.cpp

clean:
	rm -f native_test

.PHONY: run clean
