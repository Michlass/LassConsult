/*  @file server.js
 *  The server manages reads; interprets and pushes data from the serial port to a node site
 *  The Nissan Consult protocol requires a set of codes to be sent to the ECU to initialize, after which codes can be sent
 *  to request specific ECU information.
 *  
 *  @note The following rules apply:
 *  	- The Data Format is 1 start bit (always low), 8 data bits, no parity, 1 stop bit (always high) 
 * 		- The data is actually processed by the ECU's micro LSB first. Each serial string is made up of blocks of : <Start bit (0)> <8 data bits LSB-MSB(xxxxxxxx)><Stop bit (1)>
 *		- Data is sent as raw Hex,8N1, no spaces or carriage return characters etc are used
 *  
 *  @note See https://www.plmsdevelopments.com/images_ms/Consult_Protocol_&_Commands_Issue_6.pdf for reference
 */

var Log = console.log; // Easier to debug when using a shortcut
var Port_Windows = 'COM1'; // COM1 for windows laptop, /dev/ttyUSB0 for Linux
var Port_Linux = '/dev/ttyUSB0'; // COM1 for windows laptop, /dev/ttyUSB0 for Linux
var PLATFORM = process.platform; // Init the current platform for easy reference
var BAUDRATE = 9600;
var PATH_TO_SERIAL_PORT = '';
var path = require('path');
var fs = require('fs');
var express = require('express');
var serialport = require("serialport");
var SerialPort = serialport.SerialPort;

// All the values we are getting from the ECU
var rpm, kph, coolantTemp, O2_1,O2_2,batteryVoltage = 0;
var currentData= [];
var frameStarted = false;
var lengthByte;
var isConnected = false;
var command = [0x5A,0x08,0x5A,0x00,0x5A,0x01,0x5A,0x09,0x5A,0x0a,0x5A,0x0b,0x5A,0x0c,0xF0];
var bytesRequested = (command.length - 1) / 2;

Log(`This platform is ${process.platform} running in ${process.env.NODE_ENV}`);

if (process.env.NODE_ENV != "development"){
	// If we're in live mode, open the serial port, else don't 
	if (PLATFORM == "win32") {
		// Open the windows comport
		var sp = new SerialPort(Port_Windows, { baudrate: BAUDRATE });
	}
	else if (PLATFORM == "linux") {
		// Open the linux serial port
		var sp = new SerialPort(Port_Linux, { baudrate: BAUDRATE});
	}
	else {
		// Since there is no other port defined, log an error and break
		Log('Error opening serial connection, ${process.platform} not defined');
		return false
	}
}

/*
 *  Interprets the input data and checks whether this is a correct hex string
 *  
 *  @param [in] data Data which has been received
 *  @param [in] bytesExpected Expected data length
 *  @return An array of length [bytesExpected] which includes the required data
 */
function handleData(data, bytesExpected){
  // create an array of the size of requested data length and fill with requested data
  for(var i = 0; i < data.length; i++){
    // read just 1 byte at a time of the stream
    var char = data.toString('hex',i,i+1);
    if(char === "ff"){
      // Beginning of data array, the frame has started
      frameStarted = true;
      // Get rid of previous frame of data
      currentData = [];
      // remove previous lengthByte number so that we can check what this frame's byte should be
      lengthByte = undefined;
    }
	else if(frameStarted){
      // frame has started
      if(!lengthByte){
        // read lengthByte from the ECU
        lengthByte = parseInt(char, 16);
      }
	  else{
        // push byte of data onto our array
        currentData.push(parseInt(char, 16));
      }
    }
  }
  if(currentData.length === bytesExpected){
    // End of data, return the array of data
    frameStarted = false;
    return currentData.slice();
  }
}

/*
 *  Convert RPM LSB and MSB to a human readable value
 *  
 *  @param [in] mostSignificantBit (0x00)
 *  @param [in] leastSignificantBit (0x01)
 *  @return RPM
 */
function convertRPM(mostSignificantBit, leastSignificantBit){
  // combine most significant bit and least significant bit and convert to RPM
  return ((mostSignificantBit << 8) + leastSignificantBit) * 12.5;
}

/*
 *  Convert the coolant temperature to degrees centigrade
 *  
 *  @param [in] data Coolant temperature byte (0x08)
 *  @return Coolant temperature in Celsius
 */
function convertCoolantTemp(data){
  // Subtract 50 for Celsius
  var celciusCoolantTemp = data - 50;
  
  return celciusCoolantTemp;
}

/*
 *  Convert data to speed in [km/h]
 *  
 *  @param [in] data Speed byte (0x0b)
 *  @return Speed in km/h
 */
function convertKPH(data){
  // data * 2 gives KPH
  return data * 2;
}

/*
 *  Convert received data to battery voltage [mV]
 *  
 *  @param [in] data Battery voltage byte (0x0c)
 *  @return Battery voltage in [mV]
 */
function convertBatteryVoltage(data){
	// data * 80 returns mV
	return data * 80;
}

/*
 *  Convert received data to lambda sensor voltage [mV]
 *  
 *  @param [in] data Oxygen voltage byte
 *  @return Voltage of oxygensensor in [mV]
 */
function convertLambda(data){
	//data * 10 returns mV
	return data * 10;
}

/*
 *  Parse the data table in order to return legible values
 *  
 *  @param [in] data Data table
 */
function parseData(data){

  if(data !== undefined){
    coolantTemp = convertCoolantTemp(data[0]);
    rpm = convertRPM(data[1], data[2]);
    O2_1 = convertLambda(data[3]);
    O2_2 = convertLambda(data[4]);
    kph = convertKPH(data[5]);
	batteryVoltage = convertBatteryVoltage(data[6]);
  }
}

// Don't run this part for development.
if (process.env.NODE_ENV != "development"){

  sp.on("open", function () {
    // Write initialization bytes to the ECU
    sp.write([0xFF, 0xFF, 0xEF], function(err, results) {});
    sp.on('data', function(data) {
      // Check to see if the ECU is connected and has sent the connection confirmation byte "10"
      if(!isConnected && data.toString('hex') === "10"){
        console.log("connected");
        isConnected = true;
        // Tell the ECU what data we want it to give us
        sp.write(command, function(err,results){});
      }else{
        // Read the data from the stream and parse it
        parseData(handleData(data, bytesRequested));
      }
    });
  });
}

// Server part
var app = express();

app.use('/', express.static(path.join(__dirname, 'public')));

var server = app.listen(8090);
console.log('Server listening on port 8090');

// Socket.IO part
var io = require('socket.io')(server);

io.on('connection', function (socket) {
  console.log('New client connected!');

    //send data to client
    setInterval(function(){

      // Change values so you can see it go up when developing
      if (process.env.NODE_ENV === "development"){
        if(rpm < 7200){
          rpm += 11
        } else{
          rpm = 0
        }
        if(kph < 180){
          kph += 1
        } else{
          kph = 0
        }
        if(coolantTemp < 210){
          coolantTemp += 1
        } else{
          coolantTemp = 0
        }
      }

      socket.emit('ecuData', {'rpm':Math.floor(rpm),'kph':Math.floor(kph),'coolantTemp':Math.floor(coolantTemp)});
    }, 100);
});
